/**
 * The copy-trading admin for fixture mode: three users' paper copies, their
 * orders, the platform and per-user stop state and the risk policy, shaped
 * like GET /admin/copy/*. Commands and policy saves change this in-memory
 * state the way the api does (revision / version checks, reason required).
 *
 * Browser tests arm one conflict: `sessionStorage["orbie:fixtures:admin-copy-stale"]`
 * set to `control` or `risk` makes the next such write find that someone
 * else's change landed first (409 stale_revision / stale_version), once.
 */
import {
  DEFAULT_COPY_RISK_LIMITS,
  adminCopyControlRequestSchema,
  putCopyRiskRequestSchema,
  type CopyControlCommand,
  type CopyOrderStatus,
  type CopyRiskLimits,
  type CopyStrategySettings,
  type CopyStrategyStatus,
} from "@trading-dashboard/shared/contracts";

import { ApiError } from "@/lib/api";

const NOW = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;
const MIDS: Record<string, number> = { BTC: 118_420.5, ETH: 4_512.3, HYPE: 47.82, SOL: 214.6 };
const USERS: Record<number, string | null> = { 1: "demo@example.com", 7: "degen_sam@example.com", 12: null };

type Flags = { pauseNewRisk: boolean; reduceOnly: boolean; revision: number; updatedAt: Date | null };
const platform: Flags = { pauseNewRisk: false, reduceOnly: false, revision: 4, updatedAt: new Date(NOW - 2 * DAY) };
const userControls = new Map<number, Flags>([[12, { pauseNewRisk: false, reduceOnly: true, revision: 1, updatedAt: new Date(NOW - 5 * 3_600_000) }]]);
const controlOf = (userId: number): Flags => userControls.get(userId) ?? { pauseNewRisk: false, reduceOnly: false, revision: 0, updatedAt: null };

const settings = (o: Partial<CopyStrategySettings> = {}): CopyStrategySettings => ({
  direction: "same", sizingMode: "ratio", perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: "adopt", ...o,
});
interface Strategy {
  id: number; userId: number; leaderAddress: string; status: CopyStrategyStatus; allocated: number; cash: number; realizedPnl: number; fees: number;
  pauseNewRisk: boolean; reduceOnly: boolean; positions: { coin: string; size: number; entryPx: number }[]; versions: CopyStrategySettings[]; createdAt: Date;
}
const strategies: Strategy[] = [
  { id: 1, userId: 1, leaderAddress: "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f", status: "active", allocated: 2_000, cash: 2_061.37, realizedPnl: 68.92, fees: 7.55, pauseNewRisk: false, reduceOnly: false,
    positions: [{ coin: "BTC", size: 0.042, entryPx: 116_980 }, { coin: "HYPE", size: 38.5, entryPx: 45.1 }], versions: [settings()], createdAt: new Date(NOW - 5 * DAY) },
  { id: 2, userId: 1, leaderAddress: "0x880ac484a1743862989a441d6d867238c7aa311c", status: "paused", allocated: 1_500, cash: 1_471.2, realizedPnl: -24.1, fees: 4.7, pauseNewRisk: true, reduceOnly: false,
    positions: [{ coin: "ETH", size: -0.25, entryPx: 4_590.2 }], versions: [settings({ direction: "reverse", copyStartMode: "delta" }), settings({ direction: "reverse", copyStartMode: "delta", maxLeverage: 5 })], createdAt: new Date(NOW - 12 * DAY) },
  { id: 3, userId: 7, leaderAddress: "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f", status: "active", allocated: 25_000, cash: 24_310.8, realizedPnl: 412.6, fees: 61.3, pauseNewRisk: false, reduceOnly: false,
    positions: [{ coin: "BTC", size: 0.61, entryPx: 117_250 }, { coin: "SOL", size: -180, entryPx: 219.4 }], versions: [settings({ sizingMode: "fixed", perTradeUsd: 2_500, maxTotalExposureUsd: 120_000 })], createdAt: new Date(NOW - 9 * DAY) },
  { id: 4, userId: 12, leaderAddress: "0x5b5d51203a0f9079f8aeb098a6523a13f298c060", status: "active", allocated: 800, cash: 792.4, realizedPnl: 0, fees: 1.9, pauseNewRisk: false, reduceOnly: false,
    positions: [{ coin: "ETH", size: 0.4, entryPx: 4_480 }], versions: [settings()], createdAt: new Date(NOW - 1 * DAY) },
  { id: 5, userId: 12, leaderAddress: "0x880ac484a1743862989a441d6d867238c7aa311c", status: "stopped", allocated: 500, cash: 512.2, realizedPnl: 14.3, fees: 2.1, pauseNewRisk: true, reduceOnly: false,
    positions: [], versions: [settings()], createdAt: new Date(NOW - 20 * DAY) },
];

interface Order { id: number; strategyId: number; coin: string; leg: "open" | "close" | "adopt" | "stop_close" | "liquidation"; side: "B" | "A"; size: number; px: number; status: CopyOrderStatus; reason: string | null; at: Date }
let nextOrder = 9_100;
const orders: Order[] = [];
const addOrder = (o: Omit<Order, "id">) => { orders.push({ id: nextOrder++, ...o }); };
addOrder({ strategyId: 5, coin: "SOL", leg: "stop_close", side: "A", size: 2.1, px: 221.4, status: "filled", reason: null, at: new Date(NOW - 6 * DAY) });
addOrder({ strategyId: 1, coin: "BTC", leg: "adopt", side: "B", size: 0.042, px: 116_980, status: "filled", reason: null, at: new Date(NOW - 5 * DAY) });
addOrder({ strategyId: 3, coin: "BTC", leg: "open", side: "B", size: 0.61, px: 117_250, status: "filled", reason: null, at: new Date(NOW - 3 * DAY) });
addOrder({ strategyId: 1, coin: "HYPE", leg: "open", side: "B", size: 38.5, px: 45.12, status: "filled", reason: null, at: new Date(NOW - 2 * DAY) });
addOrder({ strategyId: 3, coin: "SOL", leg: "open", side: "A", size: 180, px: 219.4, status: "filled", reason: null, at: new Date(NOW - 26 * 3_600_000) });
addOrder({ strategyId: 2, coin: "ETH", leg: "open", side: "A", size: 0.25, px: 4_590.2, status: "filled", reason: null, at: new Date(NOW - 22 * 3_600_000) });
addOrder({ strategyId: 2, coin: "BTC", leg: "open", side: "A", size: 0.01, px: 118_100, status: "cancelled", reason: "strategy_paused_before_submit", at: new Date(NOW - 20 * 3_600_000) });
addOrder({ strategyId: 4, coin: "ETH", leg: "adopt", side: "B", size: 0.4, px: 4_480, status: "filled", reason: null, at: new Date(NOW - 19 * 3_600_000) });
addOrder({ strategyId: 3, coin: "ETH", leg: "open", side: "B", size: 12, px: 4_498, status: "rejected", reason: "below_min_after_max_strategy_exposure", at: new Date(NOW - 7 * 3_600_000) });
addOrder({ strategyId: 4, coin: "SOL", leg: "open", side: "B", size: 3, px: 213.9, status: "rejected", reason: "user_reduce_only", at: new Date(NOW - 4 * 3_600_000) });
addOrder({ strategyId: 1, coin: "kPEPE", leg: "open", side: "B", size: 120_000, px: 0.0112, status: "rejected", reason: "symbol_blocked", at: new Date(NOW - 95 * MIN) });
addOrder({ strategyId: 3, coin: "HYPE", leg: "open", side: "B", size: 400, px: 47.3, status: "rejected", reason: "stale_signal", at: new Date(NOW - 41 * MIN) });
addOrder({ strategyId: 1, coin: "BTC", leg: "close", side: "A", size: 0.008, px: 118_390, status: "filled", reason: null, at: new Date(NOW - 12 * MIN) });

interface Event { id: number; scope: "platform" | "user"; scopeId: number; command: CopyControlCommand; revision: number; reason: string; result: { cancelledOrders: number; closeOrders: number }; createdAt: Date }
let nextEvent = 40;
const events: Event[] = [
  { id: 39, scope: "user", scopeId: 12, command: "reduce_only", revision: 1, reason: "Exposure review after a large deposit", result: { cancelledOrders: 1, closeOrders: 0 }, createdAt: new Date(NOW - 5 * 3_600_000) },
  { id: 38, scope: "platform", scopeId: 0, command: "resume", revision: 4, reason: "Hyperliquid API incident over", result: { cancelledOrders: 0, closeOrders: 0 }, createdAt: new Date(NOW - 2 * DAY) },
  { id: 37, scope: "platform", scopeId: 0, command: "pause_new_risk", revision: 3, reason: "Hyperliquid API incident: stale mids", result: { cancelledOrders: 3, closeOrders: 0 }, createdAt: new Date(NOW - 2 * DAY - 40 * MIN) },
];

const policies: { version: number; limits: CopyRiskLimits; reason: string; createdAt: Date }[] = [
  { version: 1, limits: { ...DEFAULT_COPY_RISK_LIMITS, maxLeverage: 8 }, reason: "Initial paper limits", createdAt: new Date(NOW - 30 * DAY) },
  { version: 2, limits: { ...DEFAULT_COPY_RISK_LIMITS, maxLeverage: 8, blockedCoins: ["kPEPE"] }, reason: "Block kPEPE: precision issue in paper fills", createdAt: new Date(NOW - 6 * DAY) },
];

function armed(kind: "control" | "risk"): boolean {
  try {
    if (sessionStorage.getItem("orbie:fixtures:admin-copy-stale") !== kind) return false;
    sessionStorage.removeItem("orbie:fixtures:admin-copy-stale");
    return true;
  } catch {
    return false; // No storage (unit tests): nothing is armed.
  }
}

function view(s: Strategy) {
  const positions = s.positions.map((p) => {
    const mark = MIDS[p.coin] ?? p.entryPx;
    return { coin: p.coin, size: p.size, entryPx: p.entryPx, markPx: mark, notionalUsd: Math.abs(p.size) * mark, unrealizedPnl: p.size * (mark - p.entryPx), realizedPnl: 0, funding: 0, openedAt: s.createdAt };
  });
  const unrealized = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  const equity = s.cash + unrealized;
  const own = orders.filter((o) => o.strategyId === s.id);
  return {
    id: s.id, mode: "paper" as const, leaderAddress: s.leaderAddress, status: s.status, version: s.versions.length, settings: s.versions.at(-1)!,
    allocated: s.allocated, cash: s.cash, equity, unrealizedPnl: unrealized, realizedPnl: s.realizedPnl, fees: s.fees, funding: 0,
    totalPnl: equity - s.allocated, roiPct: ((equity - s.allocated) / s.allocated) * 100, exposureUsd: positions.reduce((a, p) => a + p.notionalUsd, 0),
    pauseNewRisk: s.pauseNewRisk, reduceOnly: s.reduceOnly, tradesCopied: own.filter((o) => o.status === "filled").length,
    pendingOrders: own.filter((o) => o.status === "risk_approved").length, positions, activatedAt: s.createdAt, createdAt: s.createdAt,
    stoppedAt: s.status === "stopped" ? new Date(NOW - 6 * DAY) : null, userId: s.userId, userEmail: USERS[s.userId] ?? null,
  };
}

function orderView(o: Order) {
  const s = strategies.find((x) => x.id === o.strategyId)!;
  const filled = o.status === "filled";
  return {
    id: String(o.id), cloid: `0x${String(o.id).padStart(32, "0")}`, strategyId: s.id, userId: s.userId, leaderAddress: s.leaderAddress, coin: o.coin, leg: o.leg, side: o.side,
    reduceOnly: o.leg === "close" || o.leg === "stop_close", size: o.size, signalPx: o.px, signalTime: o.at, status: o.status, reason: o.reason,
    filledSize: filled ? o.size : 0, avgPx: filled ? o.px : null, fee: filled ? o.size * o.px * 0.00045 : 0, builderFee: 0,
    strategyVersion: s.versions.length, riskPolicyVersion: policies.at(-1)!.version, createdAt: o.at, updatedAt: o.at, userEmail: USERS[s.userId] ?? null,
  };
}

const live = () => strategies.filter((s) => s.status !== "stopped");

export function fixtureAdminCopyOverview() {
  const count = <K extends string>(keys: K[]) => Object.fromEntries([...new Set(keys)].map((k) => [k, keys.filter((x) => x === k).length])) as Record<K, number>;
  return {
    mode: "paper" as const,
    platform: { pauseNewRisk: platform.pauseNewRisk, reduceOnly: platform.reduceOnly, revision: platform.revision, updatedAt: platform.updatedAt },
    strategies: count(strategies.map((s) => s.status)),
    orders24h: count(orders.filter((o) => o.at.getTime() > Date.now() - DAY).map((o) => o.status)),
    outbox: { pending: 2, failed: 0, checkpoint: "48211", oldestPendingAt: new Date(Date.now() - 4_000) },
    riskPolicyVersion: policies.at(-1)!.version,
    events: [...events].sort((a, b) => b.id - a.id).map((e) => ({ ...e, id: String(e.id), actorUserId: 1, actorEmail: "demo@example.com" })),
    // One close that the executor cannot book: reported, and holding its strategy's later orders.
    stuckOrders: [{ id: "9041", strategyId: 4, userId: 3, coin: "ETH", leg: "close", reduceOnly: true, attempts: 7, lastError: "numeric field overflow", since: new Date(NOW - 12 * 60_000) }],
  };
}

export function fixtureAdminCopyStrategies(search: URLSearchParams) {
  const status = search.get("status");
  const userId = Number(search.get("userId") ?? 0);
  return { items: strategies.filter((s) => (!status || s.status === status) && (!userId || s.userId === userId)).sort((a, b) => b.id - a.id).map(view) };
}

export function fixtureAdminCopyStrategy(id: number) {
  const s = strategies.find((x) => x.id === id);
  if (!s) throw new ApiError(404, "Copy not found");
  const own = orders.filter((o) => o.strategyId === id).sort((a, b) => b.id - a.id);
  return {
    strategy: view(s),
    versions: s.versions.map((v, i) => ({ version: i + 1, settings: v, createdAt: new Date(s.createdAt.getTime() + i * DAY) })).reverse(),
    orders: own.map(orderView),
    ledger: [
      ...own.filter((o) => o.status === "filled").map((o) => ({ id: String(o.id * 10), kind: "fee", amount: -(o.size * o.px * 0.00045), coin: o.coin, orderId: String(o.id), createdAt: o.at })),
      { id: String(id), kind: "allocate", amount: s.allocated, coin: null, orderId: null, createdAt: s.createdAt },
    ],
  };
}

export function fixtureAdminCopyOrders(search: URLSearchParams) {
  const status = search.get("status")?.split(",") ?? [];
  const limit = Number(search.get("limit") ?? 200);
  return { items: orders.filter((o) => status.length === 0 || status.includes(o.status)).sort((a, b) => b.id - a.id).slice(0, limit).map(orderView) };
}

export function fixtureAdminCopyExposure() {
  const users = [...new Set(live().map((s) => s.userId))];
  const items = users.map((userId) => {
    const own = live().filter((s) => s.userId === userId).map(view);
    const coins = new Map<string, { coin: string; longUsd: number; shortUsd: number; netUsd: number }>();
    for (const p of own.flatMap((s) => s.positions)) {
      const c = coins.get(p.coin) ?? { coin: p.coin, longUsd: 0, shortUsd: 0, netUsd: 0 };
      if (p.size > 0) c.longUsd += p.notionalUsd; else c.shortUsd += p.notionalUsd;
      c.netUsd = c.longUsd - c.shortUsd;
      coins.set(p.coin, c);
    }
    const control = controlOf(userId);
    return {
      userId, userEmail: USERS[userId] ?? null, strategies: own.length, allocated: own.reduce((a, s) => a + s.allocated, 0), equity: own.reduce((a, s) => a + s.equity, 0),
      exposureUsd: own.reduce((a, s) => a + s.exposureUsd, 0), coins: [...coins.values()],
      control: { pauseNewRisk: control.pauseNewRisk, reduceOnly: control.reduceOnly, revision: control.revision },
    };
  });
  return { items: items.sort((a, b) => b.exposureUsd - a.exposureUsd), pricedAt: new Date() };
}

export function fixtureAdminCopyRisk() {
  const current = policies.at(-1)!;
  return {
    version: current.version, limits: current.limits, reason: current.reason, createdAt: current.createdAt,
    history: [...policies].reverse().map((p) => ({ version: p.version, reason: p.reason, createdByUserId: 1, createdAt: p.createdAt })),
  };
}

export function fixtureAdminCopyControl(body: unknown) {
  const parsed = adminCopyControlRequestSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Invalid request", { code: "validation_error" });
  const req = parsed.data;
  const scopeId = req.scope === "platform" ? 0 : req.userId;
  if (req.scope === "user" && !(scopeId in USERS)) throw new ApiError(404, "User not found");
  const state = req.scope === "platform" ? platform : controlOf(scopeId);
  if (armed("control")) {
    // Another admin's reduce-only landed while this dialog was open.
    Object.assign(state, { reduceOnly: true, revision: state.revision + 1, updatedAt: new Date() });
    if (req.scope === "user") userControls.set(scopeId, state);
    events.push({ id: nextEvent++, scope: req.scope, scopeId, command: "reduce_only", revision: state.revision, reason: "Second operator", result: { cancelledOrders: 0, closeOrders: 0 }, createdAt: new Date() });
  }
  if (state.revision !== req.expectedRevision) {
    throw new ApiError(409, "Controls changed since this page loaded", { code: "stale_revision", revision: state.revision });
  }
  const inScope = live().filter((s) => req.scope === "platform" || s.userId === scopeId);
  const result = { cancelledOrders: 0, closeOrders: 0 };
  if (req.command === "pause_new_risk" || req.command === "close_positions") state.pauseNewRisk = true;
  if (req.command === "reduce_only") state.reduceOnly = true;
  if (req.command === "resume") Object.assign(state, { pauseNewRisk: false, reduceOnly: false });
  if (req.command === "close_positions") {
    for (const s of inScope) {
      for (const p of s.positions) {
        const mark = MIDS[p.coin] ?? p.entryPx;
        addOrder({ strategyId: s.id, coin: p.coin, leg: "stop_close", side: p.size > 0 ? "A" : "B", size: Math.abs(p.size), px: mark, status: "filled", reason: null, at: new Date() });
        s.cash += p.size * (mark - p.entryPx);
        result.closeOrders += 1;
      }
      s.positions = [];
    }
  }
  state.revision += 1;
  state.updatedAt = new Date();
  if (req.scope === "user") userControls.set(scopeId, state);
  const event: Event = { id: nextEvent++, scope: req.scope, scopeId, command: req.command, revision: state.revision, reason: req.reason, result, createdAt: new Date() };
  events.push(event);
  return {
    scope: req.scope, scopeId, state: { pauseNewRisk: state.pauseNewRisk, reduceOnly: state.reduceOnly, revision: state.revision },
    event: { ...event, id: String(event.id), actorUserId: 1, actorEmail: null },
  };
}

export function fixtureAdminCopyPutRisk(body: unknown) {
  const parsed = putCopyRiskRequestSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), { code: "validation_error" });
  if (armed("risk")) policies.push({ version: policies.at(-1)!.version + 1, limits: policies.at(-1)!.limits, reason: "Second operator", createdAt: new Date() });
  const version = policies.at(-1)!.version;
  if (version !== parsed.data.expectedVersion) throw new ApiError(409, "The risk policy changed since this page loaded", { code: "stale_version", version });
  policies.push({ version: version + 1, limits: parsed.data.limits, reason: parsed.data.reason, createdAt: new Date() });
  return fixtureAdminCopyRisk();
}

// --- testnet copies (GET /admin/copy/live/*) ----------------------------------
const LIVE_ACCOUNT = `0x${"5a".repeat(20)}`, LIVE_AT = new Date(NOW - 3 * 3_600_000).toISOString();
const liveGrant: { id: string; version: number; scopes: string[]; expiresAt: string; revokedAt: string | null; revokeRequestedAt: string | null } = {
  id: "grant-demo", version: 4, scopes: ["copy:trade", "copy:reduce"], expiresAt: new Date(NOW + 20 * DAY).toISOString(), revokedAt: null, revokeRequestedAt: null };
/** The demo copy is running: an admin revoke stops it first (as the api). */
let liveCopy: { strategyStatus: string; stop: { id: string; state: string; issue: string | null } | null } = { strategyStatus: "active", stop: null };

export function fixtureAdminLiveAccounts() {
  return { items: [{ accountId: "account-demo", userId: 1, userEmail: USERS[1], strategyId: 41, leaderAddress: `0x${"4b".repeat(20)}`, sourceNetwork: "mainnet" as const,
    accountAddress: LIVE_ACCOUNT, accountState: "ready", strategyStatus: liveCopy.strategyStatus, agent: { setupId: "setup-demo", state: "active", agentAddress: `0x${"3c".repeat(20)}`, expiresAt: liveGrant.expiresAt },
    grant: { ...liveGrant }, mandate: { id: "mandate-demo", state: liveCopy.stop ? "stopping" : "active", revision: liveCopy.stop ? 3 : 2 }, stop: liveCopy.stop, createdAt: LIVE_AT }] };
}
export function fixtureAdminLiveTransfers() {
  return { items: [{ id: "6f1c2a4e-3b7d-4c8e-9a1f-2d3e4f5a6b7c", userId: 1, accountId: "account-demo", strategyId: 41, direction: "to_account" as const, status: "credited", amount: "50",
    source: `0x${"11".repeat(20)}`, destination: LIVE_ACCOUNT, stopId: null, transactionHash: `0x${"ab".repeat(32)}`, attemptedAt: LIVE_AT, createdAt: LIVE_AT, updatedAt: LIVE_AT }] };
}
export function fixtureAdminLiveOrders(state: string | null) {
  const order = { key: `testnet:${LIVE_ACCOUNT}:0x${"7e".repeat(16)}`, userId: 1, strategyId: 41, accountAddress: LIVE_ACCOUNT, coin: "BTC", side: "B" as const, size: "0.0004", limitPrice: "118456",
    reduceOnly: false, state: "unknown", errorCode: "exchange_order_not_yet_found", purpose: "copy" as const, leg: { leg: "open" as const, state: "submitted", reason: null },
    createdAt: new Date(NOW - 20_000).toISOString(), updatedAt: new Date(NOW - 5_000).toISOString() };
  return { items: state === "all" || state === "open" || state === "unknown" || state === null ? [order] : [] };
}
export function fixtureAdminLiveLatency(window: string | null) {
  const w = window === "7d" ? "7d" as const : "24h" as const;
  return { window: w, count: w === "7d" ? 61 : 9, signal: { p50: 840, p95: 2_350 }, sent: { p50: 1_320, p95: 58_900 }, ack: { p50: 1_480, p95: 59_200 }, settled: { p50: 4_900, p95: 66_000 } };
}
export function fixtureAdminLiveRevoke(id: string, body: unknown) {
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (typeof reason !== "string" || reason.trim().length < 3) throw new ApiError(400, "reason is required", { code: "validation_failed" });
  if (id !== liveGrant.id) throw new ApiError(404, "Wallet authorization not found");
  if (!liveGrant.revokedAt && (body as { force?: unknown }).force === true) {
    liveGrant.version += 1; liveGrant.revokedAt = new Date().toISOString(); liveGrant.revokeRequestedAt = null;
  } else if (!liveGrant.revokedAt && !liveGrant.revokeRequestedAt) {
    liveGrant.revokeRequestedAt = new Date().toISOString();
    liveCopy = { strategyStatus: "stopping", stop: { id: "7a1c2a4e-3b7d-4c8e-9a1f-2d3e4f5a6b70", state: "requested", issue: null } };
  }
  return { id, version: liveGrant.version, revokedAt: liveGrant.revokedAt, revokeRequestedAt: liveGrant.revokedAt ? null : liveGrant.revokeRequestedAt, stopId: liveGrant.revokedAt ? null : liveCopy.stop?.id ?? null };
}
