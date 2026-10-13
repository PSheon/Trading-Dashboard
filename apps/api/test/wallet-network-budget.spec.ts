import { describe, expect, it } from "vitest";

import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import type { HyperliquidGlobalTransport } from "../src/hyperliquid/hyperliquid-global-transport.js";
import { PostgresHyperliquidQuota } from "../src/hyperliquid/postgres-hyperliquid-quota.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { walletNetworkHyperliquid } from "../src/copy/copy.module.js";
import { ATTEMPT_WEIGHT } from "../src/copy/copy-account-mode.service.js";
import { LIVE_RESERVE_WAIT_MS, liveBudget } from "../src/hyperliquid/hyperliquid-budget-wait.js";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", NODE_ENV: "test", HYPERLIQUID_EGRESS_KEY: "egress" };
const config = (env: Record<string, string>) => new AppConfig(validateEnvironment({ ...base, ...env }));
// Only the instance check runs at construction; nothing is read here.
const quota = Object.create(PostgresHyperliquidQuota.prototype) as PostgresHyperliquidQuota;
const transport = {} as HyperliquidGlobalTransport;

describe("the wallet network's Hyperliquid budget", () => {
  it("on testnet, copy setup calls get their own bucket and egress key instead of waiting behind the api's mainnet page traffic", () => {
    const cfg = config({ HYPERLIQUID_NETWORK: "testnet" });
    const main = new RequestBudgeterService(cfg);
    const info = new HyperliquidInfoClient(cfg, main), wallet = walletNetworkHyperliquid(cfg, main, transport, quota, info);
    expect(wallet.budget).not.toBe(main);
    expect(wallet.transport).not.toBe(transport);
    // Wallet balances, ledgers, withdrawals and copy funding scans read
    // through this client: a testnet 429 no longer halves the mainnet budget.
    expect(wallet.dedicated).toBe(true); expect(wallet.info).not.toBe(info);
    expect((wallet.info as unknown as { budgeter: unknown }).budgeter).toBe(wallet.budget);
    expect(wallet.budget.introspect()).toMatchObject({ configuredBudgetPerMin: 300, burstCapacity: 900 });
    // Copy setups' steps have a bucket of their own beside it: the order bucket's burst is the orders'.
    expect(wallet.setupBudget).not.toBe(wallet.budget); expect(wallet.setupBudget).not.toBe(main);
    expect(wallet.setupBudget.introspect()).toMatchObject({ configuredBudgetPerMin: 300, burstCapacity: 900 });
  });

  it("on mainnet, the wallet network is the mainnet host: the api's own budget and transport", () => {
    const cfg = config({ HYPERLIQUID_NETWORK: "mainnet" });
    const main = new RequestBudgeterService(cfg);
    const info = new HyperliquidInfoClient(cfg, main), wallet = walletNetworkHyperliquid(cfg, main, transport, quota, info);
    expect(wallet.budget).toBe(main);
    expect(wallet.transport).toBe(transport);
    expect(wallet.dedicated).toBe(false); expect(wallet.info).toBe(info);
    expect(wallet.setupBudget).toBe(main);
  });

  it("on mainnet with real-money copy, setup steps get their own bucket: a main bucket drained by background work no longer stalls the account-mode step", async () => {
    // The worker's main bucket on Stage (360/840), kept empty by snapshots,
    // analytics and sweeps: the 613 account-mode reservation waited there
    // for hours (setup 6c101127, 2026-10-11).
    const cfg = config({ HYPERLIQUID_NETWORK: "mainnet", IS_WORKER: "true", HYPERLIQUID_STARTUP_PACE_SECONDS: "0" });
    const live = new AppConfig({ ...cfg.value, copy: { ...cfg.value.copy, live: { network: "mainnet" as const, caps: { maxStrategiesPerUser: 2 }, builderFee: false,
      testnetSourceIntervalMs: 60_000, maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300, revokeDeadlineMs: 1_800_000 } } });
    const main = new RequestBudgeterService(live);
    const info = new HyperliquidInfoClient(live, main), wallet = walletNetworkHyperliquid(live, main, transport, quota, info);
    await main.acquire(main.liveCapacity, "background");
    expect(wallet.dedicated).toBe(true);
    expect(wallet.budget).not.toBe(main);
    expect(wallet.setupBudget).not.toBe(wallet.budget); expect(wallet.setupBudget).not.toBe(main);
    // Same host, IP and egress key: the shared per-IP meter counts both.
    expect(wallet.transport).toBe(transport);
    expect(wallet.config.value.hyperliquid.egressKey).toBe("egress");
    // Wallet page reads stay on the main budget.
    expect(wallet.info).toBe(info);
    expect(wallet.budget.introspect()).toMatchObject({ configuredBudgetPerMin: 300, burstCapacity: 900 });
    await expect(liveBudget(wallet.budget, { maxWaitMs: LIVE_RESERVE_WAIT_MS })(ATTEMPT_WEIGHT)).resolves.toBeUndefined();
    main.onModuleDestroy(); wallet.budget.onModuleDestroy();
  });

  it("background work can never spend a wallet bucket below what one live order's evidence (589) or a setup's account mode (613) needs (local testnet 2026-10-12)", async () => {
    const cfg = config({ HYPERLIQUID_NETWORK: "testnet", HYPERLIQUID_STARTUP_PACE_SECONDS: "0" });
    const main = new RequestBudgeterService(cfg), wallet = walletNetworkHyperliquid(cfg, main, transport, quota, new HyperliquidInfoClient(cfg, main));
    // Receipts and snapshots take everything background may take, 10 at a time.
    for (;;) {
      try { await wallet.budget.acquire(10, "background", undefined, { signal: AbortSignal.timeout(20) }); }
      catch { break; }
    }
    expect(wallet.budget.liveWaitMs(589)).toBe(0);
    expect(wallet.budget.liveWaitMs(ATTEMPT_WEIGHT)).toBe(0);
    main.onModuleDestroy(); wallet.budget.onModuleDestroy();
  });
});

