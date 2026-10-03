import { createHash } from "node:crypto";
import { Dec } from "../../common/decimal/dec.js";
import { LiveBoundaryError, address, type WalletRequest } from "./wallet-authorization.js";

export interface LiveOrderIntent extends WalletRequest {
  cloid: `0x${string}`;
  asset: number;
  side: "B" | "A";
  size: string;
  limitPrice: string;
  sizeDecimals: number;
  timeInForce: "Ioc" | "Gtc" | "Alo";
}

export interface HyperliquidOrderAction {
  type: "order";
  orders: [{ a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Ioc" | "Gtc" | "Alo" } }; c: `0x${string}` }];
  grouping: "na";
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
  if (!Number.isSafeInteger(intent.asset) || intent.asset < 0 || intent.asset >= 10_000) throw new LiveBoundaryError("unsupported_perpetual_asset");
  if (!Number.isSafeInteger(intent.sizeDecimals) || intent.sizeDecimals < 0 || intent.sizeDecimals > 6) throw new LiveBoundaryError("invalid_size_decimals");
  if (!["B", "A"].includes(intent.side) || !["Ioc", "Gtc", "Alo"].includes(intent.timeInForce) || typeof intent.reduceOnly !== "boolean") throw new LiveBoundaryError("invalid_order_flags");
  const size = wireDecimal(intent.size);
  const price = wireDecimal(intent.limitPrice);
  if ((size.split(".")[1]?.length ?? 0) > intent.sizeDecimals) throw new LiveBoundaryError("size_precision_exceeded");
  const decimals = price.split(".")[1]?.length ?? 0;
  const significant = price.replace(".", "").replace(/^0+/, "").length;
  // Perpetual prices allow at most 5 significant figures, except integer prices.
  if (decimals > 6 - intent.sizeDecimals || (decimals > 0 && significant > 5)) throw new LiveBoundaryError("price_precision_exceeded");
  return { type: "order", orders: [{ a: intent.asset, b: intent.side === "B", p: price, s: size, r: intent.reduceOnly, t: { limit: { tif: intent.timeInForce } }, c: intent.cloid }], grouping: "na" };
}

export function executionKey(intent: Pick<LiveOrderIntent, "network" | "accountAddress" | "cloid">): string {
  return `${intent.network}:${address(intent.accountAddress)}:${intent.cloid}`;
}

export function intentFingerprint(intent: LiveOrderIntent, action: HyperliquidOrderAction): string {
  return createHash("sha256").update(JSON.stringify({ authorizationId: intent.authorizationId, userId: intent.userId,
    strategyId: intent.strategyId, walletId: intent.walletId, network: intent.network, account: address(intent.accountAddress), action })).digest("hex");
}
