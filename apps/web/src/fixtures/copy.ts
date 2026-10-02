/**
 * Paper copy trading for fixture mode: an in-memory paper account and its
 * copies, shaped exactly like GET /me/copy. `?paper=empty` in the page URL
 * starts with no copies; otherwise two seeded copies (one long BTC/HYPE
 * follow, one counter ETH) so the portfolio has something to show.
 *
 * Browser tests arm one failure: `sessionStorage["orbie:fixtures:copy-fail"]`
 * set to `patch`, `commands` or `funds` makes the next such request answer
 * 503 once, so a control's error state can be driven through the real UI.
 */
import { ApiError } from "@/lib/api";
import type { CopyStrategySettings } from "@trading-dashboard/shared/contracts";

type Position = { coin: string; size: number; entryPx: number; openedAt: Date; realizedPnl: number; funding: number };
type Order = {
  id: string; coin: string; leg: "open" | "close" | "adopt" | "stop_close" | "liquidation"; side: "B" | "A"; size: number; px: number | null;
  status: "filled" | "rejected" | "cancelled" | "risk_approved"; reason: string | null; at: Date; fee: number;
};
type Strategy = {
  id: number; leaderAddress: string; status: "active" | "paused" | "stopping" | "stopped"; version: number;
  settings: CopyStrategySettings; allocated: number; cash: number; realizedPnl: number; fees: number; funding: number;
  pauseNewRisk: boolean; reduceOnly: boolean; positions: Position[]; orders: Order[]; createdAt: Date; stoppedAt: Date | null;
};

const MIDS: Record<string, number> = { BTC: 118_420.5, ETH: 4_512.3, HYPE: 47.82, SOL: 214.6 };
const STARTING = 10_000;
const day = 86_400_000;
const mode = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("paper") : null;

const settings = (o: Partial<CopyStrategySettings> = {}): CopyStrategySettings => ({
  direction: "same", sizingMode: "ratio", perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: "adopt", ...o,
});
let nextId = 3;
let nextOrder = 100;
const order = (o: Omit<Order, "id">): Order => ({ id: String(nextOrder++), ...o });

const strategies: Strategy[] =
  mode === "empty"
    ? []
    : [
        {
          id: 1, leaderAddress: "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f", status: "active", version: 1, settings: settings(),
          allocated: 2_000, cash: 2_061.37, realizedPnl: 68.92, fees: 7.55, funding: 0, pauseNewRisk: false, reduceOnly: false,
          positions: [
            { coin: "BTC", size: 0.042, entryPx: 116_980, openedAt: new Date(Date.now() - 5 * day), realizedPnl: 0, funding: 0.84 },
            { coin: "HYPE", size: 38.5, entryPx: 45.1, openedAt: new Date(Date.now() - 2 * day), realizedPnl: 0, funding: 0.21 },
          ],
          orders: [
            order({ coin: "HYPE", leg: "open", side: "B", size: 38.5, px: 45.12, status: "filled", reason: null, at: new Date(Date.now() - 2 * day), fee: 0.78 }),
            order({ coin: "SOL", leg: "close", side: "A", size: 4.2, px: 221.4, status: "filled", reason: null, at: new Date(Date.now() - 3 * day), fee: 0.42 }),
            order({ coin: "kPEPE", leg: "open", side: "B", size: 0, px: null, status: "rejected", reason: "below_min_notional", at: new Date(Date.now() - 4 * day), fee: 0 }),
            order({ coin: "BTC", leg: "adopt", side: "B", size: 0.042, px: 116_980, status: "filled", reason: null, at: new Date(Date.now() - 5 * day), fee: 2.21 }),
          ],
          createdAt: new Date(Date.now() - 5 * day), stoppedAt: null,
        },
        {
          id: 2, leaderAddress: "0x880ac484a1743862989a441d6d867238c7aa311c", status: "paused", version: 2, settings: settings({ direction: "reverse", copyStartMode: "delta" }),
          allocated: 1_500, cash: 1_471.2, realizedPnl: -24.1, fees: 4.7, funding: 0, pauseNewRisk: true, reduceOnly: false,
          positions: [{ coin: "ETH", size: -0.25, entryPx: 4_590.2, openedAt: new Date(Date.now() - 1 * day), realizedPnl: 0, funding: -0.12 }],
          orders: [
            order({ coin: "ETH", leg: "open", side: "A", size: 0.25, px: 4_590.2, status: "filled", reason: null, at: new Date(Date.now() - 1 * day), fee: 0.52 }),
            order({ coin: "BTC", leg: "open", side: "A", size: 0.01, px: null, status: "cancelled", reason: "strategy_paused_before_submit", at: new Date(Date.now() - 20 * 3_600_000), fee: 0 }),
          ],
          createdAt: new Date(Date.now() - 12 * day), stoppedAt: null,
        },
      ];
let balance = STARTING - strategies.reduce((a, s) => a + s.allocated, 0);

function view(s: Strategy) {
  const positions = s.positions.map((p) => {
    const mark = MIDS[p.coin] ?? p.entryPx;
    return {
      coin: p.coin, size: p.size, entryPx: p.entryPx, markPx: mark, notionalUsd: Math.abs(p.size) * mark,
      unrealizedPnl: p.size * (mark - p.entryPx), realizedPnl: p.realizedPnl, funding: p.funding, openedAt: p.openedAt,
    };
  });
  const unrealized = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  const equity = s.cash + unrealized;
  const totalPnl = equity - s.allocated;
  return {
    id: s.id, mode: "paper" as const, leaderAddress: s.leaderAddress, status: s.status, version: s.version, settings: s.settings,
    allocated: s.allocated, cash: s.cash, equity, unrealizedPnl: unrealized, realizedPnl: s.realizedPnl, fees: s.fees, funding: s.funding,
    totalPnl, roiPct: (totalPnl / s.allocated) * 100, exposureUsd: positions.reduce((a, p) => a + p.notionalUsd, 0),
    pauseNewRisk: s.pauseNewRisk, reduceOnly: s.reduceOnly, tradesCopied: s.orders.filter((o) => o.status === "filled").length,
    pendingOrders: s.orders.filter((o) => o.status === "risk_approved").length, positions, activatedAt: s.createdAt, createdAt: s.createdAt, stoppedAt: s.stoppedAt,
  };
}

export function fixtureCopyOverview() {
  const views = strategies.map(view);
  const live = views.filter((s) => s.status !== "stopped");
  const totalValue = balance + live.reduce((a, s) => a + s.equity, 0);
  return {
    mode: "paper" as const,
    paper: { balance, startingBalance: STARTING, allocated: live.reduce((a, s) => a + s.allocated, 0), totalValue, totalPnl: totalValue - STARTING },
    limits: { minAllocationUsd: 100, maxAllocationUsd: 100_000, maxStrategies: 10 },
    platform: { pauseNewRisk: false, reduceOnly: false, revision: 0 },
    user: { pauseNewRisk: false, reduceOnly: false, revision: 0 },
    strategies: views,
    pricedAt: new Date(),
  };
}

function owned(id: number): Strategy {
  const s = strategies.find((x) => x.id === id);
  if (!s) throw new ApiError(404, "Copy not found");
  return s;
}
const conflict = (code: string, message: string) => new ApiError(409, message, { code });

const FAIL_KEY = "orbie:fixtures:copy-fail";
function failOnce(kind: "patch" | "commands" | "funds") {
  let armed = false;
  try {
    armed = sessionStorage.getItem(FAIL_KEY) === kind;
    if (armed) sessionStorage.removeItem(FAIL_KEY);
  } catch {
    // No storage (unit tests): nothing is armed.
  }
  if (armed) throw new ApiError(503, "Service unavailable", { code: "unavailable" });
}

export function fixtureStartCopy(body: Record<string, unknown>) {
  const leader = String(body.leader ?? "").toLowerCase();
  const amount = Number(body.allocationUsd);
  if (!/^0x[0-9a-f]{40}$/.test(leader) || !(amount > 0)) throw new ApiError(400, "Invalid request", { code: "validation_error" });
  if (amount < 100) throw conflict("below_min_allocation", "Minimum allocation is $100");
  if (strategies.some((s) => s.leaderAddress === leader && s.status !== "stopped")) throw conflict("already_copying", "You are already copying this trader");
  if (amount > balance) throw conflict("insufficient_balance", "Not enough paper balance");
  const direction = body.direction === "reverse" ? "reverse" : "same";
  const adopt = body.copyStartMode !== "delta";
  const now = new Date();
  const positions: Position[] = adopt ? [{ coin: "BTC", size: (direction === "same" ? 1 : -1) * Number(((amount * 0.6) / MIDS.BTC).toFixed(5)), entryPx: MIDS.BTC, openedAt: now, realizedPnl: 0, funding: 0 }] : [];
  const fee = positions.reduce((a, p) => a + Math.abs(p.size) * p.entryPx * 0.00045, 0);
  const s: Strategy = {
    id: nextId++, leaderAddress: leader, status: "active", version: 1,
    settings: settings({ direction, copyStartMode: adopt ? "adopt" : "delta" }),
    allocated: amount, cash: amount - fee, realizedPnl: 0, fees: fee, funding: 0, pauseNewRisk: false, reduceOnly: false, positions,
    orders: positions.map((p) => order({ coin: p.coin, leg: "adopt", side: p.size > 0 ? "B" : "A", size: Math.abs(p.size), px: p.entryPx, status: "filled", reason: null, at: now, fee })),
    createdAt: now, stoppedAt: null,
  };
  strategies.unshift(s);
  balance -= amount;
  // 跟單目前持倉: the trader's BTC is adopted; a builder-dex position is not copied.
  return adopt ? { ...view(s), adoption: [{ coin: "BTC", adopted: true, reason: null, size: Math.abs(positions[0]!.size) }, { coin: "xyz:TSLA", adopted: false, reason: "symbol_not_allowed", size: 0 }] } : view(s);
}

/** As the api: a new version; a stopped copy is 409, fixed sizing needs its amount. */
export function fixturePatchCopy(id: number, body: Record<string, unknown>) {
  failOnce("patch");
  const s = owned(id);
  if (s.status === "stopped" || s.status === "stopping") throw conflict("strategy_stopped", "This copy has stopped");
  const next = { ...s.settings, ...(body as Partial<CopyStrategySettings>) };
  if (next.sizingMode === "fixed" && next.perTradeUsd === null) throw new ApiError(400, "Fixed sizing needs an amount per trade", { code: "per_trade_required" });
  s.settings = next;
  s.version += 1;
  return view(s);
}

export function fixtureAddFunds(id: number, body: Record<string, unknown>) {
  failOnce("funds");
  const s = owned(id);
  const amount = Number(body.amountUsd);
  if (!(amount > 0) || amount > balance) throw conflict("insufficient_balance", "Not enough paper balance");
  balance -= amount;
  s.allocated += amount;
  s.cash += amount;
  return view(s);
}

export function fixtureCopyCommand(id: number, body: Record<string, unknown>) {
  failOnce("commands");
  const s = owned(id);
  if (s.status === "stopped") throw conflict("strategy_stopped", "This copy has stopped");
  switch (body.command) {
    case "pause":
      Object.assign(s, { pauseNewRisk: true, status: "paused" });
      break;
    case "resume":
      Object.assign(s, { pauseNewRisk: false, reduceOnly: false, status: "active" });
      break;
    case "reduce_only":
      s.reduceOnly = true;
      break;
    case "stop":
    case "close_positions": {
      for (const p of s.positions) {
        const mark = MIDS[p.coin] ?? p.entryPx;
        const pnl = p.size * (mark - p.entryPx);
        const fee = Math.abs(p.size) * mark * 0.00045;
        s.cash += pnl - fee;
        s.realizedPnl += pnl;
        s.fees += fee;
        s.orders.unshift(order({ coin: p.coin, leg: "stop_close", side: p.size > 0 ? "A" : "B", size: Math.abs(p.size), px: mark, status: "filled", reason: null, at: new Date(), fee }));
      }
      s.positions = [];
      s.pauseNewRisk = true;
      if (body.command === "stop") {
        s.status = "stopped";
        s.stoppedAt = new Date();
        balance += s.cash;
      } else s.status = "paused";
      break;
    }
    default:
      break;
  }
  return view(s);
}

export function fixtureCopyOrders(id: number) {
  const s = owned(id);
  return {
    items: s.orders.map((o) => ({
      id: o.id, cloid: `0x${o.id.padStart(32, "0")}`, strategyId: s.id, userId: 1, leaderAddress: s.leaderAddress, coin: o.coin, leg: o.leg, side: o.side,
      reduceOnly: o.leg === "close" || o.leg === "stop_close", size: o.size, signalPx: o.px ?? MIDS[o.coin] ?? 1, signalTime: o.at, status: o.status, reason: o.reason,
      filledSize: o.status === "filled" ? o.size : 0, avgPx: o.status === "filled" ? o.px : null, fee: o.fee, builderFee: 0, strategyVersion: s.version,
      riskPolicyVersion: 0, createdAt: o.at, updatedAt: o.at,
    })),
  };
}
