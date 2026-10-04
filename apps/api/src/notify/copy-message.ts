import type { Locale } from "@trading-dashboard/shared/contracts";
import { z } from "zod";

import { publicOrderReason } from "../copy/copy-order-reason.js";
import { fill, telegramMessages, type TelegramMessages } from "./messages/index.js";
import { formatPrice, formatUsd, safeDisplayName, shortAddress } from "./message-template.js";

/**
 * The owner events the trade bot sends (CopyDog's Trade Bot, "alerts when
 * copy trades execute"): every fill (open, add, reduce, close), a
 * liquidation, an order the copy could not place, the copy's funding (money
 * added, withdrawn, returned at stop) and its stop. Hourly funding-rate
 * payments are not messages (they are in the copy's ledger).
 */
export const COPY_NOTIFICATION_TYPES = ["order_rejected", "order_cancelled", "order_filled", "position_liquidated", "strategy_stopped", "funds_added", "funds_withdrawn", "funds_returned"] as const;
export const copyDeliveryPayloadSchema = z.object({
  version: z.literal(2), kind: z.literal("copy"), text: z.string(), chatId: z.string(),
  eventId: z.string().regex(/^\d+$/), mode: z.literal("paper"),
});

type Reasons = TelegramMessages["copy"]["reasons"];
/** A public order-reason code as one of the localized groups. */
export function reasonGroup(code: string): keyof Reasons {
  const base = code.replace(/_before_(?:submit|fill)$/, "");
  if (/paused|reduce_only$|stopping|stopped|user_disabled/.test(base) && base !== "reduce_only_no_position") return "paused";
  if (/^risk_cap_|^below_min|max_per_trade/.test(base)) return "risk";
  if (/stale_price|stale_signal|no_price|no_asset_info|leader_equity_unknown|price_moved/.test(base)) return "market";
  if (/opposite_position|reduce_only_no_position|zero_size/.test(base)) return "position";
  if (/settings|no_per_trade_amount|risk_policy_invalid|missing_reservation/.test(base)) return "settings";
  if (base.startsWith("symbol_")) return "symbol";
  if (base === "frequency") return "frequency";
  return "other";
}

/** "0.0420" → "0.042": a decimal from the payload, as typed. */
const decimal = (value: unknown): string | null =>
  typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 50 ? value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : null;
const signedUsd = (value: number) => `${value >= 0 ? "+" : "−"}${formatUsd(Math.abs(value))}`;

/**
 * One owner event as a Telegram message in the recipient's language. Only
 * allowlisted fields of the payload are read, never the payload as text;
 * the trader's address is shortened. Paper events say they are simulated
 * in their first line.
 */
export function renderCopyMessage(
  event: { id: bigint; strategyId: number | null; type: string; payload: Record<string, unknown>; createdAt: Date },
  baseUrl: string,
  locale: Locale | string | null = "en",
  leaderAddress: string | null = null,
): string {
  const m = telegramMessages(locale).copy;
  const side = telegramMessages(locale).side;
  const p = event.payload;
  const mode = p.mode === "testnet" || p.mode === "live" ? p.mode : "paper";
  const action = typeof p.action === "string" ? p.action : null;
  const title =
    event.type === "order_filled" ? (action === "open" || action === "increase" || action === "decrease" || action === "close" ? m.title[action] : m.title.filled)
    : event.type === "position_liquidated" ? m.title.liquidated
    : event.type === "order_rejected" ? m.title.rejected
    : event.type === "order_cancelled" ? m.title.cancelled
    : event.type === "strategy_stopped" ? m.title.stopped
    : event.type === "funds_added" ? m.title.fundsAdded
    : event.type === "funds_withdrawn" ? m.title.fundsWithdrawn
    : event.type === "funds_returned" ? m.title.fundsReturned
    : m.title.filled;
  const lines = [m.header[mode], title];
  if (leaderAddress) lines.push(fill(m.trader, { trader: shortAddress(leaderAddress) }));
  const coin = typeof p.coin === "string" ? safeDisplayName(p.coin) : null;
  const size = decimal(p.size);
  const px = decimal(p.px);
  if (coin && (p.side === "B" || p.side === "A") && size) {
    lines.push(fill(m.fill, { side: p.side === "B" ? side.buy : side.sell, size, coin, price: px ? formatPrice(Number(px)) : "—" }));
  }
  const realized = decimal(p.realizedPnl);
  const fee = decimal(p.fee);
  if ((event.type === "position_liquidated" || action === "decrease" || action === "close") && realized !== null) {
    lines.push(fill(m.pnl, { pnl: signedUsd(Number(realized) - Number(fee ?? 0)) }));
  }
  const amount = decimal(p.amount);
  if (amount !== null && event.type.startsWith("funds_")) lines.push(fill(m.amount, { amount: formatUsd(Math.abs(Number(amount))) }));
  if (event.type === "order_rejected" || event.type === "order_cancelled") {
    const code = publicOrderReason(p.reason);
    lines.push(fill(m.reason, { reason: `${m.reasons[reasonGroup(code)]} (${code})` }));
  }
  lines.push(`${event.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC`, fill(m.event, { id: String(event.id) }), fill(m.link, { url: `${baseUrl}/portfolio${event.strategyId ? `?copy=${event.strategyId}` : ""}` }));
  return lines.join("\n");
}
