import { createHash } from "node:crypto";
import { Dec } from "../../common/decimal/dec.js";
import { LiveBoundaryError, address, type WalletRequest } from "./wallet-authorization.js";
import { assertMarketIdentity, marketIdentityKey, type LiveMarketIdentity } from './live-market-resolver.js';

export interface LiveOrderIntent extends WalletRequest {
  cloid: `0x${string}`;
  asset: number;
  side: "B" | "A";
  size: string;
  limitPrice: string;
  sizeDecimals: number;
  timeInForce: "Ioc" | "Gtc" | "Alo";
  /** Resolved identity. Mandatory for production signing, optional only for
   * old journal compatibility (reconciliation resolves its saved asset). */
  market?: LiveMarketIdentity;
  /** Local requested cap is not approval evidence. The transport must read
   * maxBuilderFee uncached on the exact account at financial boundaries. */
  builder?: { address: string; feeTenthsBps: number; approvedMaxFeeTenthsBps: number };
}

export interface HyperliquidOrderAction {
  type: "order";
  orders: [{ a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Ioc" | "Gtc" | "Alo" } }; c: `0x${string}` }];
  grouping: "na";
  builder?: { b: `0x${string}`; f: number };
}

/** Exact wire decimals only: rounding a prepared order would change its risk approval. */
export function wireDecimal(value: string): string {
  if (typeof value !== "string" || value.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw new LiveBoundaryError("invalid_wire_decimal");
  const decimal = Dec.from(value);
  if (!decimal.isPositive) throw new LiveBoundaryError("nonpositive_wire_decimal");
  return decimal.toString();
}

export function buildOrderAction(intent: LiveOrderIntent): HyperliquidOrderAction {
  if (!/^0x[0-9a-f]{32}$/.test(intent.cloid)) throw new LiveBoundaryError("invalid_cloid");
  if (!Number.isSafeInteger(intent.asset) || intent.asset < 0) throw new LiveBoundaryError("unsupported_perpetual_asset");
  if (intent.market) {
    assertMarketIdentity(intent.market);
    if (intent.market.network !== intent.network || intent.market.asset !== intent.asset || intent.market.sizeDecimals !== intent.sizeDecimals)
      throw new LiveBoundaryError('live_market_identity_mismatch');
  } else if (intent.asset >= 10_000) throw new LiveBoundaryError('live_market_identity_missing');
  if (!Number.isSafeInteger(intent.sizeDecimals) || intent.sizeDecimals < 0 || intent.sizeDecimals > 6) throw new LiveBoundaryError("invalid_size_decimals");
  if (!["B", "A"].includes(intent.side) || !["Ioc", "Gtc", "Alo"].includes(intent.timeInForce) || typeof intent.reduceOnly !== "boolean") throw new LiveBoundaryError("invalid_order_flags");
  const size = wireDecimal(intent.size);
  const price = wireDecimal(intent.limitPrice);
  if ((size.split(".")[1]?.length ?? 0) > intent.sizeDecimals) throw new LiveBoundaryError("size_precision_exceeded");
  const decimals = price.split(".")[1]?.length ?? 0;
  const significant = price.replace(".", "").replace(/^0+/, "").length;
  // Perpetual prices allow at most 5 significant figures, except integer prices.
  if (decimals > 6 - intent.sizeDecimals || (decimals > 0 && significant > 5)) throw new LiveBoundaryError("price_precision_exceeded");
  let builder: HyperliquidOrderAction['builder'];
  if (intent.builder) {
    const b = intent.builder;
    if (!Number.isSafeInteger(b.feeTenthsBps) || b.feeTenthsBps < 0 || b.feeTenthsBps > 100 ||
        !Number.isSafeInteger(b.approvedMaxFeeTenthsBps) || b.approvedMaxFeeTenthsBps < b.feeTenthsBps || b.approvedMaxFeeTenthsBps > 100)
      throw new LiveBoundaryError('invalid_builder_fee');
    builder = { b: address(b.address), f: b.feeTenthsBps };
  }
  return { type: "order", orders: [{ a: intent.asset, b: intent.side === "B", p: price, s: size, r: intent.reduceOnly, t: { limit: { tif: intent.timeInForce } }, c: intent.cloid }], grouping: "na", ...(builder ? { builder } : {}) };
}

export function executionKey(intent: Pick<LiveOrderIntent, "network" | "accountAddress" | "cloid">): string {
  return `${intent.network}:${address(intent.accountAddress)}:${intent.cloid}`;
}

export function intentFingerprint(intent: LiveOrderIntent, action: HyperliquidOrderAction): string {
  return createHash("sha256").update(JSON.stringify({ authorizationId: intent.authorizationId, userId: intent.userId,
    strategyId: intent.strategyId, walletId: intent.walletId, network: intent.network, account: address(intent.accountAddress), action,
    ...(intent.market ? { market: marketIdentityKey(intent.market) } : {}) })).digest("hex");
}
