import { DEFAULT_COPY_RISK_LIMITS, type CopyStrategySettings } from "@trading-dashboard/shared/contracts";
import { describe, expect, it, vi } from "vitest";

import { d } from "../src/common/decimal/dec.js";
import { CopyExecutionService } from "../src/copy/copy-execution.service.js";
import { AssetMap, type CopyMarketService, type Mids } from "../src/copy/copy-market.service.js";
import type { CopyRepository, OrderRow, PositionRow, StrategyRow } from "../src/copy/copy.repository.js";
import type { CopyRiskPolicyService } from "../src/copy/copy-risk-policy.service.js";
import type { UnitOfWork } from "../src/db/unit-of-work.js";
import type { SettingsService } from "../src/settings/settings.service.js";

// These boundary tests use an in-memory transaction adapter, never a database.
function fixture() {
  let inTransaction = false;
  const order = {
    id: 1n, strategyId: 1, userId: 10, strategyVersion: 1, riskPolicyVersion: 1,
    coin: "BTC", side: "B", size: "1", reduceOnly: false, leg: "open", status: "risk_approved",
    signalPx: "100", signalTime: new Date(), createdAt: new Date(), reason: null,
  } as OrderRow;
  const strategy = {
    id: 1, userId: 10, version: 1, controlRevision: 3, status: "active", allocated: "1000", cash: "1000",
    pauseNewRisk: false, reduceOnly: false,
  } as StrategyRow;
  const settings: CopyStrategySettings = {
    direction: "same", sizingMode: "fixed", perTradeUsd: 100, maxTotalExposureUsd: null,
    maxLeverage: 5, copyStartMode: "delta",
  };
  const policy = { version: 2, invalid: false, limits: { ...DEFAULT_COPY_RISK_LIMITS, simulatedSlippageBps: 0, takerFeeBps: 0 } };
  const positions: PositionRow[] = [];
  const reservations = [{ orderId: 1n, strategyId: 1, coin: "BTC", notional: "100", margin: "20", status: "held" }];
  const mids: Mids = { at: new Date(), px: new Map([["BTC", d(100)], ["ETH", d(100)]]), missingDexes: new Set() };
  const assets = new AssetMap([["BTC", { szDecimals: 3, maxLeverage: 40, funding: d(0), markPx: d(100) }]]);
  const controls = { platform: { revision: 7, pauseNewRisk: false, reduceOnly: false }, user: { revision: 8, pauseNewRisk: false, reduceOnly: false } };
  const reservationPatch = vi.fn();
  const tx = {};
  const repository = {
    lockPoliciesForExecution: vi.fn(async () => undefined), lockCopyUser: vi.fn(async () => undefined),
    heldReservationRows: vi.fn(async () => reservations.filter((r) => r.status === "held")),
    refreshHeldReservation: vi.fn(async (_tx: unknown, _orderId: bigint, amounts: unknown) => reservationPatch(amounts)),
    reader: {}, userCanCopy: vi.fn(async () => true), orderOwner: vi.fn(async () => ({ userId: 10, strategyId: 1 })),
    orderCoins: vi.fn(async () => [order.coin]), liveStrategyIdsOfUser: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
    positionsOf: vi.fn(async (ids: number[]) => positions.filter((p) => ids.includes(p.strategyId))),
    readControls: vi.fn(async () => controls), lockStrategy: vi.fn(async () => strategy), lockOrder: vi.fn(async () => ({ ...order })),
    settingsOf: vi.fn(async () => ({ ...settings })), ordersLastMinute: vi.fn(async () => 1),
    updateOrder: vi.fn(async (_tx: unknown, _id: bigint, patch: Partial<OrderRow>) => Object.assign(order, patch)),
    settleReservation: vi.fn(async (_tx: unknown, _id: bigint, status: string) => { const row = reservations.find((r) => r.orderId === _id); if (row) row.status = status; }),
  };
  const policies = { current: vi.fn(async () => policy) };
  const market = {
    midPrices: vi.fn(async () => { expect(inTransaction).toBe(false); return mids; }),
    assetInfo: vi.fn(async () => { expect(inTransaction).toBe(false); return assets; }),
  };
  const uow = { run: async (work: (tx: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try { return await work(tx); } finally { inTransaction = false; }
  } };
  const service = new CopyExecutionService(
    repository as unknown as CopyRepository, uow as unknown as UnitOfWork, market as unknown as CopyMarketService,
    policies as unknown as CopyRiskPolicyService,
    { get: async () => ({ builderFeeTenthsBps: 0 }) } as unknown as SettingsService,
  );
  return { service, order, strategy, settings, policy, positions, reservations, mids, assets, controls, repository, market, policies, reservationPatch };
}

describe("copy execution authoritative boundary", () => {
  it("reads prices outside locks, excludes only its own reservation, and records effective revisions", async () => {
    const f = fixture();
    f.policy.limits.maxCoinExposureUsd = 100;
    expect(await f.service.submit(1n)).toBe("submitting");
    expect(f.order.riskPolicyVersion).toBe(1);
    expect(f.order.executionPolicyVersion).toBe(2);
    expect(f.order.executionControlRevisions).toEqual({ platform: 7, user: 8, strategy: 3 });
    expect(f.reservationPatch).toHaveBeenCalledWith({ notional: "100", margin: "20" });
    expect(f.policies.current).toHaveBeenCalledTimes(1);
    expect(f.repository.lockPoliciesForExecution).toHaveBeenCalledOnce();
    expect(f.repository.lockCopyUser).toHaveBeenCalledWith(expect.anything(), 10);
    expect(f.repository.lockCopyUser.mock.invocationCallOrder[0]).toBeLessThan(f.repository.readControls.mock.invocationCallOrder[0]!);
    expect(f.repository.readControls.mock.invocationCallOrder[0]).toBeLessThan(f.repository.lockStrategy.mock.invocationCallOrder[0]!);
    expect(f.repository.refreshHeldReservation).toHaveBeenCalledWith(expect.anything(), 1n, { notional: "100", margin: "20" });
  });

  it("disabled owners cannot submit new risk", async () => {
    const f = fixture();
    f.repository.userCanCopy.mockResolvedValue(false);
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toBe("user_disabled_before_submit");
  });

  it("cancels an already approved order after a platform cap tightens", async () => {
    const f = fixture();
    f.policy.limits.maxOrderNotionalUsd = 50;
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toBe("risk_cap_max_order_before_submit");
    expect(f.reservations[0]!.status).toBe("released");
  });

  it("does not borrow another identical reservation's room", async () => {
    const f = fixture();
    f.reservations.push({ orderId: 2n, strategyId: 1, coin: "BTC", notional: "100", margin: "20", status: "held" });
    f.policy.limits.maxCoinExposureUsd = 150;
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toContain("max_coin_exposure");
    expect(f.reservations[1]!.status).toBe("held");
  });

  it("applies blocked symbols case insensitively", async () => {
    const f = fixture();
    f.policy.limits.blockedCoins = ["btc"];
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toBe("symbol_blocked_before_submit");
  });

  it("applies HIP-3 permission before requiring a price", async () => {
    const f = fixture();
    f.order.coin = "xyz:TSLA";
    f.policy.limits.allowHip3 = false;
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toBe("symbol_not_allowed_before_submit");
  });

  it("fails closed on invalid policy", async () => {
    const f = fixture();
    f.policy.invalid = true;
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toBe("risk_policy_invalid_before_submit");
  });

  it("uses current strategy exposure settings", async () => {
    const f = fixture();
    f.strategy.version = 2;
    f.settings.maxTotalExposureUsd = 50;
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.strategyVersion).toBe(1);
    expect(f.order.executionStrategyVersion).toBe(2);
    expect(f.order.reason).toContain("max_strategy_exposure");
  });

  it("uses a tightened per-trade amount", async () => {
    const f = fixture();
    f.strategy.version = 2;
    f.repository.settingsOf.mockImplementation(async (_tx?: unknown, _id?: number, version?: number) => ({ ...f.settings, perTradeUsd: version === 1 ? 100 : 50 }));
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toBe("max_per_trade_before_submit");
  });

  it("fails closed on missing or stale current prices instead of using the signal price", async () => {
    for (const stale of [false, true]) {
      const f = fixture();
      if (stale) f.mids.at = new Date(Date.now() - 60_000);
      else f.mids.px.delete("BTC");
      expect(await f.service.submit(1n)).toBe("cancelled");
      expect(f.order.reason).toBe(`${stale ? "stale_price" : "no_price"}_before_submit`);
    }
  });

  it("requires prices for the user's other holdings", async () => {
    const f = fixture();
    f.positions.push({ strategyId: 2, coin: "xyz:TSLA", size: "1", entryPx: "100" } as PositionRow);
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toBe("no_price_before_submit");
    expect(f.market.midPrices).toHaveBeenCalledWith(expect.arrayContaining(["xyz:TSLA"]));
  });

  it("uses current marked equity and full held exposure", async () => {
    const f = fixture();
    f.strategy.cash = "100";
    f.positions.push({ strategyId: 1, coin: "ETH", size: "1", entryPx: "190" } as PositionRow);
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toContain("max_strategy_exposure");
  });

  it("refreshes reserved margin when current leverage tightens", async () => {
    const f = fixture();
    f.settings.maxLeverage = 2;
    expect(await f.service.submit(1n)).toBe("submitting");
    expect(f.reservationPatch).toHaveBeenCalledWith({ notional: "100", margin: "50" });
  });

  it("does not double-count the approved order toward frequency", async () => {
    const f = fixture();
    f.policy.limits.maxOrdersPerMinute = 1;
    expect(await f.service.submit(1n)).toBe("submitting");
  });

  it("keeps adoption exempt from age and frequency, and cannot loosen age via caller override", async () => {
    const f = fixture();
    f.order.signalTime = new Date(0);
    expect(await f.service.submit(1n, Number.MAX_SAFE_INTEGER)).toBe("cancelled");
    expect(f.order.reason).toBe("stale_signal_before_submit");
    const adopt = fixture();
    adopt.order.leg = "adopt";
    adopt.order.signalTime = new Date(0);
    adopt.repository.ordersLastMinute.mockResolvedValue(999);
    expect(await adopt.service.submit(1n)).toBe("submitting");
  });

  it("allows reductions despite invalid policy, blocked coin, pauses and unavailable pricing", async () => {
    const f = fixture();
    f.order.reduceOnly = true;
    f.policy.invalid = true;
    f.policy.limits.blockedCoins = ["BTC"];
    f.controls.platform.pauseNewRisk = true;
    f.mids.px.clear();
    f.mids.at = new Date(0);
    expect(await f.service.submit(1n)).toBe("submitting");
  });

  it("values exposure at mid while reserving the simulated fill costs", async () => {
    const f = fixture();
    f.policy.limits.maxOrderNotionalUsd = 100;
    f.policy.limits.simulatedSlippageBps = 10;
    expect(await f.service.submit(1n)).toBe("submitting");
    expect(f.reservationPatch).toHaveBeenCalledWith({ notional: "100", margin: "20" });
  });

  it("includes simulated slippage and fees in the equity available for margin", async () => {
    for (const cost of ["slippage", "fee"]) {
      const f = fixture();
      f.strategy.cash = "100";
      f.settings.maxLeverage = 1;
      if (cost === "slippage") f.policy.limits.simulatedSlippageBps = 10;
      else f.policy.limits.takerFeeBps = 10;
      expect(await f.service.submit(1n)).toBe("cancelled");
      expect(f.order.reason).toContain("max_strategy_exposure");
    }
  });

  it("fails closed when its held reservation is missing", async () => {
    const f = fixture();
    f.reservations.length = 0;
    expect(await f.service.submit(1n)).toBe("cancelled");
    expect(f.order.reason).toBe("missing_reservation_before_submit");
  });

  it("rechecks controls after submission and before the paper fill", async () => {
    const f = fixture();
    expect(await f.service.submit(1n)).toBe("submitting");
    f.controls.user.reduceOnly = true;
    expect(await f.service.fill(1n, {
      mids: f.mids, assets: f.assets, slippageBps: 0, takerFeeBps: 0, builderFeeTenthsBps: 0,
    })).toBe(false);
    expect(f.order.reason).toBe("user_reduce_only_before_fill");
  });

  it("revalidates paper orders left submitting after restart", async () => {
    const f = fixture();
    f.order.status = "submitting";
    f.policy.limits.blockedCoins = ["BTC"];
    expect(await f.service.fill(1n, {
      mids: f.mids, assets: f.assets, slippageBps: 0, takerFeeBps: 0, builderFeeTenthsBps: 0,
    })).toBe(false);
    expect(f.order.reason).toBe("symbol_blocked_before_fill");
    expect(f.reservations[0]!.status).toBe("released");
  });
});
