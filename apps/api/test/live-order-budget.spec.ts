import { afterEach, describe, expect, it, vi } from "vitest";

import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import type { HyperliquidGlobalTransport } from "../src/hyperliquid/hyperliquid-global-transport.js";
import { PostgresHyperliquidQuota } from "../src/hyperliquid/postgres-hyperliquid-quota.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { walletNetworkHyperliquid } from "../src/hyperliquid/wallet-network-hyperliquid.js";
import { assertBucketHolds, HyperliquidBudgetWait, liveBudget, reserveLive } from "../src/hyperliquid/hyperliquid-budget-wait.js";
import { ATTEMPT_WEIGHT } from "../src/copy/copy-account-mode.service.js";
import { CopyFundingExchangeClient } from "../src/copy/copy-funding-exchange.client.js";
import { assertLiveEvidenceCapacity, evidenceFinalCheck, evidenceFirstWave, liveEvidencePrepaidWeight, liveInfoWeights, LiveSharedReads,
  MAX_EVIDENCE_CHARGE } from "../src/copy/live/live-shared-reads.js";
import { LiveBoundaryError } from "../src/copy/live/wallet-authorization.js";
import { errorCode } from "../src/runtime/safe-error-text.js";
import { planHyperliquidQuota, type HyperliquidQuotaState } from "../src/hyperliquid/hyperliquid-global-quota.js";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", NODE_ENV: "test", HYPERLIQUID_EGRESS_KEY: "egress", HYPERLIQUID_STARTUP_PACE_SECONDS: "0" };
/** COPY_LIVE_WEIGHT_PER_MIN is read with COPY_TRADING_MODE=testnet (and its signing keys): set it on the parsed config. */
const config = ({ COPY_LIVE_WEIGHT_PER_MIN, ...env }: Record<string, string>) => {
  const value = validateEnvironment({ ...base, ...env });
  return new AppConfig(COPY_LIVE_WEIGHT_PER_MIN === undefined ? value
    : { ...value, copy: { ...value.copy, live: { maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: Number(COPY_LIVE_WEIGHT_PER_MIN) } } });
};
// Only the instance check runs at construction; nothing is read here.
const quota = Object.create(PostgresHyperliquidQuota.prototype) as PostgresHyperliquidQuota;
const transport = {} as HyperliquidGlobalTransport;
/** The bucket copy orders pay their evidence from, as HyperliquidModule builds it. */
function orderBucket(env: Record<string, string>) {
  const cfg = config(env), main = new RequestBudgeterService(cfg);
  return walletNetworkHyperliquid(cfg, main, transport, quota, new HyperliquidInfoClient(cfg, main));
}
const users = (n: number) => Array.from({ length: n }, (_, i) => `0x${String(i + 1).padStart(40, "0")}`);

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the order path's token bucket", () => {
  it("one order's prepaid evidence: 204 a user + 160, exactly what the epoch's two waves weigh", () => {
    for (const n of [1, 2, 3, 9]) {
      const observed = users(n);
      expect(liveEvidencePrepaidWeight(n)).toBe(liveInfoWeights(evidenceFirstWave(observed, observed[0]!, "BTC")) + liveInfoWeights(evidenceFinalCheck(observed)));
      expect(liveEvidencePrepaidWeight(n)).toBe(204 * n + 160);
    }
  });

  it("refuses to boot at COPY_LIVE_WEIGHT_PER_MIN=700: its bucket (500) can't hold one order of any owner", () => {
    const wallet = orderBucket({ HYPERLIQUID_NETWORK: "testnet", COPY_LIVE_WEIGHT_PER_MIN: "700" });
    expect(wallet.budget.liveCapacity).toBe(500);
    for (const maxStrategiesPerUser of [1, 2, 10])
      expect(() => assertLiveEvidenceCapacity({ capacity: wallet.budget.liveCapacity, maxStrategiesPerUser, network: wallet.network, budgetPerMin: 700 }))
        .toThrow(/weighs (568|772|1996), more than the testnet order bucket can hold \(500 at 700\/min/);
  });

  it("the testnet default (300/min, capacity 900) holds two accounts plus the leader, not three", () => {
    const wallet = orderBucket({ HYPERLIQUID_NETWORK: "testnet" });
    expect(wallet.budget.liveCapacity).toBe(900);
    expect(assertLiveEvidenceCapacity({ capacity: 900, maxStrategiesPerUser: 2, network: "testnet", budgetPerMin: 300 })).toEqual({ users: 3, weight: 772, capacity: 900 });
    expect(() => assertLiveEvidenceCapacity({ capacity: 900, maxStrategiesPerUser: 3, network: "testnet", budgetPerMin: 300 })).toThrow(/3 live accounts plus the leader weighs 976.*\(2 fit\)/);
  });

  it("the mainnet worker's defaults (360/840) hold two accounts plus the leader, whatever the api-shaped HYPERLIQUID_WEIGHT_* say", () => {
    // Stage's worker sets HYPERLIQUID_WEIGHT_* = 360/100 (docs/railway-deploy.md): a 100 bucket on mainnet.
    const wallet = orderBucket({ HYPERLIQUID_NETWORK: "mainnet", IS_WORKER: "true", HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: "360", HYPERLIQUID_WEIGHT_BURST: "100" });
    expect(wallet.dedicated).toBe(false);
    expect(wallet.budget.introspect()).toMatchObject({ configuredBudgetPerMin: 360, burstCapacity: 840 });
    expect(assertLiveEvidenceCapacity({ capacity: wallet.budget.liveCapacity, maxStrategiesPerUser: 2, network: "mainnet", budgetPerMin: 360 }))
      .toEqual({ users: 3, weight: 772, capacity: 840 });
    // Explicit worker values still win; the api keeps its own.
    expect(orderBucket({ HYPERLIQUID_NETWORK: "mainnet", IS_WORKER: "true", HYPERLIQUID_WORKER_WEIGHT_BURST: "500" }).budget.liveCapacity).toBe(500);
    expect(orderBucket({ HYPERLIQUID_NETWORK: "mainnet", HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: "480" }).budget.introspect()).toMatchObject({ configuredBudgetPerMin: 480, burstCapacity: 200 });
  });

  it("every evidence wave goes out in meter charges of at most the unlabelled share (360), even with the leader", async () => {
    expect(MAX_EVIDENCE_CHARGE).toBe(360);
    const charges: number[] = [];
    const ok = (body: Record<string, unknown>) => new Response(JSON.stringify(body.type === "perpDexs" ? [null] : {}));
    const shared = new LiveSharedReads(vi.fn(), async (bodies, onDispatch) => { onDispatch(); charges.push(liveInfoWeights(bodies)); return bodies.map(ok); }, Date.now);
    const observed = users(3);
    await shared.wave(evidenceFirstWave(observed, observed[0]!, "BTC"));
    expect(charges.reduce((a, b) => a + b, 0)).toBe(446);
    expect(Math.max(...charges)).toBeLessThanOrEqual(360);
  });

  it("a reservation heavier than the bucket fails at once with a coded error instead of waiting", async () => {
    vi.useFakeTimers();
    const budget = orderBucket({ HYPERLIQUID_NETWORK: "testnet", COPY_LIVE_WEIGHT_PER_MIN: "700" }).budget;
    const settled = reserveLive(budget, 772).then(() => "acquired", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const error = await settled;
    expect(error).toBeInstanceOf(LiveBoundaryError);
    expect((error as LiveBoundaryError).code).toBe("live_budget_over_capacity");
    expect(budget.queued()).toEqual({ live: 0, background: 0 });
    expect(budget.introspect().tokensAvailable).toBe(500);
  });

  it("a wait that runs out is a HyperliquidBudgetWait (stored as live_budget_wait), never a bare TimeoutError", async () => {
    vi.useFakeTimers();
    const budget = orderBucket({ HYPERLIQUID_NETWORK: "testnet" }).budget;
    await budget.acquire(900, "live");
    // Another order's evidence is already waiting for the whole bucket (180 s).
    void budget.acquire(900, "live").catch(() => undefined);
    const client = new CopyFundingExchangeClient(budget);
    const settled = client.acquire().then(() => "acquired", (error: unknown) => error);
    // The send waits for the order bucket at most 10 s; an empty one needs more.
    await vi.advanceTimersByTimeAsync(12_000);
    const error = await settled;
    expect(error).toBeInstanceOf(HyperliquidBudgetWait);
    expect(errorCode(error)).toBe("live_budget_wait");
  });

  it("an order's evidence waits the bucket's refill time, not 5 s: on an empty 900 bucket at 300/min, 772 goes out after about 155 s", async () => {
    vi.useFakeTimers();
    const budget = orderBucket({ HYPERLIQUID_NETWORK: "testnet" }).budget;
    await budget.acquire(900, "live");
    const shared = new LiveSharedReads(vi.fn(), undefined, Date.now, 5000, liveBudget(budget));
    let paid = false;
    const payment = shared.pay(772).then(() => { paid = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paid).toBe(false);
    await vi.advanceTimersByTimeAsync(150_000);
    await payment;
    expect(paid).toBe(true);
    expect(shared.paidWeight).toBe(772);
  });

  it("HYPERLIQUID_BACKGROUND_REST_CAP keeps room on the shared window for an order's evidence beside a full background lane", () => {
    const now = 1_800_000_000_000;
    const charge = (state: HyperliquidQuotaState, id: string, weight: number, lane: "background" | undefined, backgroundCap?: number) =>
      planHyperliquidQuota({ now, state, leases: [], backgroundCap, request: { kind: "rest", id, weight, sendUntil: now + 1000, ...(lane ? { lane } : {}) } }).state;
    const empty: HyperliquidQuotaState = { egressKey: "egress", revision: 1, events: [], updatedAt: now };
    // Default 840: a full background lane leaves 360, less than one order (772 with the leader).
    expect(() => charge(charge(empty, "bg", 840, "background"), "order", 772, undefined)).toThrow();
    expect(config({}).value.hyperliquid.backgroundRestCap).toBe(840);
    // 400 on the canary: background stops at 400 and the order fits.
    const full = charge(empty, "bg", 400, "background", 400);
    expect(() => charge(full, "bg2", 1, "background", 400)).toThrow();
    expect(charge(full, "order", 772, undefined, 400).events.reduce((sum, e) => sum + e.units, 0)).toBe(1172);
    expect(config({ HYPERLIQUID_BACKGROUND_REST_CAP: "400" }).value.hyperliquid.backgroundRestCap).toBe(400);
  });

  it("a copy setup's account-mode attempt (613) must fit the bucket that reserves it: the api's mainnet 200 can't, 480/720 can", () => {
    expect(ATTEMPT_WEIGHT).toBe(613);
    const api = (env: Record<string, string>) => orderBucket({ HYPERLIQUID_NETWORK: "mainnet", HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: "480", ...env }).budget;
    expect(() => assertBucketHolds(api({ HYPERLIQUID_WEIGHT_BURST: "200" }), ATTEMPT_WEIGHT, "attempt", "fix")).toThrow(/attempt weighs 613, more than .* \(200: /);
    expect(() => assertBucketHolds(api({ HYPERLIQUID_WEIGHT_BURST: "720" }), ATTEMPT_WEIGHT, "attempt", "fix")).not.toThrow();
    expect(() => assertBucketHolds(orderBucket({ HYPERLIQUID_NETWORK: "testnet" }).budget, ATTEMPT_WEIGHT, "attempt", "fix")).not.toThrow();
  });
});
