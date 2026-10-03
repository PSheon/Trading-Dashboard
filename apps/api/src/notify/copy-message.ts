import { publicOrderReason } from "../copy/copy-order-reason.js";
import { z } from "zod";
import { safeDisplayName } from "./message-template.js";

export const COPY_NOTIFICATION_TYPES = ["order_rejected", "order_cancelled", "order_filled", "position_liquidated", "strategy_stopped", "funds_added", "funds_withdrawn", "funds_returned"] as const;
export const copyDeliveryPayloadSchema = z.object({
  version: z.literal(2), kind: z.literal("copy"), text: z.string(), chatId: z.string(),
  eventId: z.string().regex(/^\d+$/), mode: z.literal("paper"),
});

/** Render only explicitly allowlisted event fields, never arbitrary payloads. */
export function renderCopyMessage(event: { id: bigint; strategyId: number | null; type: string; payload: Record<string, unknown>; createdAt: Date }, baseUrl: string): string {
  const labels: Record<string, string> = {
    order_rejected: "Order rejected", order_cancelled: "Order cancelled",
    order_filled: "Order filled", position_liquidated: "Position liquidated", strategy_stopped: "Strategy stopped",
    funds_added: "Funds added", funds_withdrawn: "Funds withdrawn", funds_returned: "Funds returned",
  };
  const numeric = (value: unknown) => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 50 ? value : null;
  const p = event.payload;
  const details: string[] = [];
  if (event.type === "order_rejected" || event.type === "order_cancelled") details.push(`Reason: ${publicOrderReason(p.reason)}`);
  if (typeof p.coin === "string") details.push(safeDisplayName(p.coin));
  if (p.side === "B" || p.side === "A") details.push(p.side === "B" ? "Buy" : "Sell");
  if (numeric(p.size)) details.push(`Size: ${numeric(p.size)}`);
  if (numeric(p.px)) details.push(`Price: $${numeric(p.px)}`);
  if (numeric(p.amount)) details.push(`Amount: $${numeric(p.amount)}`);
  return ["Orbie · PAPER / simulated funds", labels[event.type] ?? "Copy activity", `Strategy #${event.strategyId ?? "—"}`, ...details,
    event.createdAt.toISOString(), `Event #${event.id}`, `${baseUrl}/portfolio`].join("\n");
}
