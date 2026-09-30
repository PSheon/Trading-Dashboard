import type { TraderOrder, TraderTransfer, TraderTwap, TransferKind } from "@trading-dashboard/shared/contracts";

import type { HlFrontendOpenOrder, HlLedgerUpdate, HlTwapHistoryEntry, HlUserFill } from "../hyperliquid/types.js";

/**
 * The trader page's 訂單 / TWAP / 轉帳 tabs: Hyperliquid's info answers
 * mapped to the rows CopyDog shows (its bundle's orders, TWAP and transfers
 * tables and its ledger classifier, read 2026-09-30).
 */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const lower = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v.toLowerCase() : null);

// --- 訂單 ---------------------------------------------------------------------

export function toTraderOrder(o: HlFrontendOpenOrder): TraderOrder {
  const triggerPx = numOrNull(o.triggerPx);
  return {
    oid: String(o.oid),
    coin: o.coin,
    side: o.side === "B" ? "buy" : "sell",
    orderType: o.orderType ?? (o.isTrigger ? "Trigger" : "Limit"),
    size: num(o.sz),
    origSize: num(o.origSz ?? o.sz),
    limitPx: numOrNull(o.limitPx),
    // Hyperliquid sends "0.0" for an order without a trigger.
    triggerPx: o.isTrigger && triggerPx ? triggerPx : null,
    isTrigger: o.isTrigger ?? false,
    triggerCondition: o.triggerCondition && o.triggerCondition !== "N/A" ? o.triggerCondition : null,
    reduceOnly: o.reduceOnly ?? false,
    isPositionTpsl: o.isPositionTpsl ?? false,
    placedAt: new Date(o.timestamp),
  };
}

/** Every dex's orders, largest value first (CopyDog's default sort). */
export function mergeOrders(lists: HlFrontendOpenOrder[][]): TraderOrder[] {
  const seen = new Set<number>();
  const out: TraderOrder[] = [];
  for (const list of lists) {
    for (const o of list) {
      if (seen.has(o.oid)) continue;
      seen.add(o.oid);
      out.push(toTraderOrder(o));
    }
  }
  const value = (o: TraderOrder) => o.size * (o.limitPx ?? 0);
  return out.sort((a, b) => value(b) - value(a) || b.placedAt.getTime() - a.placedAt.getTime());
}

// --- TWAP ---------------------------------------------------------------------

/**
 * The TWAPs still running: those whose latest `twapHistory` status is
 * "activated". Their progress is the size of their slice fills among the
 * latest ones we hold (`userTwapSliceFills`, 2,000 newest), capped at the
 * TWAP's size; Hyperliquid's own `executedSz` is only filled in when a TWAP
 * ends. Newest first.
 */
export function activeTwaps(history: HlTwapHistoryEntry[], slices: HlUserFill[]): TraderTwap[] {
  const latest = new Map<number, HlTwapHistoryEntry>();
  for (const entry of history) {
    const seen = latest.get(entry.twapId);
    if (!seen || entry.time >= seen.time) latest.set(entry.twapId, entry);
  }
  const filled = new Map<number, number>();
  for (const f of slices) {
    if (f.twapId == null) continue;
    filled.set(f.twapId, (filled.get(f.twapId) ?? 0) + num(f.sz));
  }
  const out: TraderTwap[] = [];
  for (const [twapId, entry] of latest) {
    if (entry.status.status !== "activated") continue;
    const size = num(entry.state.sz);
    const executed = Math.max(num(entry.state.executedSz), filled.get(twapId) ?? 0);
    const filledSize = size > 0 ? Math.min(size, executed) : executed;
    out.push({
      twapId,
      coin: entry.state.coin,
      side: entry.state.side === "B" ? "buy" : "sell",
      size,
      filledSize,
      filledFraction: size > 0 ? filledSize / size : 0,
      minutes: entry.state.minutes,
      reduceOnly: entry.state.reduceOnly,
      randomize: entry.state.randomize,
      startedAt: new Date(entry.state.timestamp || entry.time * 1000),
    });
  }
  return out.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

// --- 轉帳 ---------------------------------------------------------------------

/** Hyperliquid's system address that bridges spot tokens to HyperEVM. */
export const HYPER_EVM_BRIDGE = "0x2222222222222222222222222222222222222222";

const DIRECTION: Record<TransferKind, TraderTransfer["direction"]> = {
  deposit: "in", received: "in", vaultWithdraw: "in", unstaked: "in", rewards: "in", genesis: "in",
  delegationReceived: "in", commission: "in", vaultDistribution: "in",
  withdraw: "out", sent: "out", vaultDeposit: "out", staked: "out", delegationSent: "out", liquidated: "out",
  vaultCreate: "out", toHyperEvm: "out",
  generic: "move", toPerp: "move", fromPerp: "move", toSubaccount: "move", dexAbstraction: "move",
};

/**
 * One ledger update as a 轉帳 row, classified as CopyDog does (its bundle's
 * ledger classifier): the kind, the asset and amount (token units, or USD
 * for vault and liquidation rows), and the counterparties. Null for a kind
 * CopyDog doesn't list either.
 */
export function toTraderTransfer(update: HlLedgerUpdate, address: string): TraderTransfer | null {
  const self = address.toLowerCase();
  const d = update.delta as Record<string, unknown> & { type: string };
  const destination = lower(d.destination);
  const user = lower(d.user);
  let token = typeof d.token === "string" && d.token ? d.token : "USDC";
  let amount = Math.abs(num(d.usdc) || num(d.usdcValue));
  let usd = false;
  let from: string | null = null;
  let to: string | null = null;
  let kind: TransferKind;
  switch (d.type) {
    case "deposit":
      kind = "deposit";
      to = self;
      break;
    case "withdraw":
    case "withdraw3":
      kind = "withdraw";
      from = self;
      break;
    case "spotTransfer":
    case "internalTransfer":
      if (typeof d.token === "string" && d.amount != null) amount = Math.abs(num(d.amount));
      from = user;
      to = destination;
      kind = d.type === "spotTransfer" && (user === HYPER_EVM_BRIDGE || destination === HYPER_EVM_BRIDGE)
        ? "toHyperEvm"
        : destination === self ? "received" : "generic";
      break;
    case "send":
      amount = Math.abs(num(d.amount)) || amount;
      from = user;
      to = destination;
      kind = destination === self ? "received" : "sent";
      break;
    case "accountClassTransfer":
      kind = d.toPerp ? "toPerp" : "fromPerp";
      from = self;
      to = self;
      break;
    case "subAccountTransfer":
      kind = "toSubaccount";
      from = user;
      to = destination;
      break;
    case "vaultDeposit":
      kind = "vaultDeposit";
      usd = true;
      from = self;
      to = lower(d.vault);
      break;
    case "vaultWithdraw":
      kind = "vaultWithdraw";
      usd = true;
      amount = Math.abs(num(d.netWithdrawnUsd) || num(d.requestedUsd)) || amount;
      from = lower(d.vault);
      to = self;
      break;
    case "vaultCreate":
      kind = "vaultCreate";
      usd = true;
      from = self;
      to = lower(d.vault);
      break;
    case "vaultDistribution":
      kind = "vaultDistribution";
      usd = true;
      from = lower(d.vault);
      to = self;
      break;
    case "vaultLeaderCommission":
      kind = "commission";
      usd = true;
      to = self;
      break;
    case "cStakingTransfer":
      token = typeof d.token === "string" && d.token ? d.token : "HYPE";
      amount = Math.abs(num(d.amount));
      kind = d.isDeposit ? "staked" : "unstaked";
      break;
    case "delegationSentFromPool":
      token = typeof d.token === "string" && d.token ? d.token : "HYPE";
      amount = Math.abs(num(d.amount));
      kind = "delegationSent";
      break;
    case "delegationReceivedToPool":
      token = typeof d.token === "string" && d.token ? d.token : "HYPE";
      amount = Math.abs(num(d.amount));
      kind = "delegationReceived";
      break;
    case "spotGenesis":
      amount = Math.abs(num(d.amount));
      kind = "genesis";
      to = self;
      break;
    case "rewardsClaim":
      amount = Math.abs(num(d.amount)) || amount;
      kind = "rewards";
      to = self;
      break;
    case "liquidation":
      kind = "liquidated";
      usd = true;
      amount = Math.abs(num(d.liquidatedNtlPos));
      break;
    case "agentEnableDexAbstraction":
    case "activateDexAbstraction":
      kind = "dexAbstraction";
      amount = 0;
      break;
    default:
      return null;
  }
  return { time: new Date(update.time), hash: update.hash, kind, direction: DIRECTION[kind], token, amount, usd, from, to };
}
