import type { MessageKey } from "@/i18n/messages";

const ledgerKinds = new Set(["allocate", "realized_pnl", "fee", "builder_fee", "funding", "release", "withdraw", "liquidation"]);
const commands = new Set(["pause", "resume", "reduce_only", "cancel_pending", "close_positions", "stop"]);

/** Unknown server values stay readable without looking up a missing catalog key. */
export function copyRecordLabel(kind: "ledgerKinds" | "commandLabels", value: string, t: (key: MessageKey) => string): string {
  return (kind === "ledgerKinds" ? ledgerKinds : commands).has(value)
    ? t(`copyUpdates.${kind}.${value}` as MessageKey)
    : value.replaceAll("_", " ");
}
