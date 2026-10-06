"use client";

import { copyRecordLabel } from "./copy-labels";
import { Link } from "@/i18n/navigation";
import { PaperBadge } from "@/components/copy/paper-badge";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { useCopyEvents } from "@/lib/copy";
import type { WireCopyEvents } from "@trading-dashboard/shared/contracts";
import { TextButton } from "@/components/ui/text-button";

const reasonKeys = new Set(["platform_paused", "platform_reduce_only", "user_paused", "user_reduce_only", "strategy_paused", "strategy_reduce_only", "symbol_not_allowed", "symbol_blocked", "stale_signal", "no_price", "price_moved", "frequency", "zero_size", "below_min_notional", "leader_equity_unknown", "no_asset_info", "no_per_trade_amount", "reduce_only_no_position"]);

const eventKeys = new Set(["strategy_created", "strategy_command", "funds_added", "funds_withdrawn", "funds_returned", "order_filled", "position_liquidated"]);

export function CopyActivityItems({ items }: { items: WireCopyEvents["items"] }) {
  const { t, format } = useI18n();
  if (!items.length) return <p className="py-6 text-center text-xs text-muted-foreground">{t("copyUpdates.activityEmpty")}</p>;
  return <ol className="mt-2 divide-y-2 divide-dotted divide-border">
    {[...items].reverse().map((event) => {
      const amount = typeof event.payload.amount === "number" || typeof event.payload.amount === "string" ? Number(event.payload.amount) : null;
      const coin = typeof event.payload.coin === "string" ? event.payload.coin : null;
      const command = typeof event.payload.command === "string" ? copyRecordLabel("commandLabels", event.payload.command, t) : null;
      const terminal = event.type === "order_rejected" || event.type === "order_cancelled";
      const orderId = typeof event.payload.orderId === "string" && /^\d+$/.test(event.payload.orderId) ? event.payload.orderId : null;
      const reason = typeof event.payload.reason === "string" ? event.payload.reason.replace(/_before_(?:submit|fill)$/, "") : "";
      const eventLabel = terminal ? t(event.type === "order_rejected" ? "copyUpdates.orderRejected" : "copyUpdates.orderCancelled") : eventKeys.has(event.type) ? t(`copyUpdates.events.${event.type}` as MessageKey) : event.type.replaceAll("_", " ");
      return <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-semibold">{eventLabel}</span>
          {event.strategyId !== null ? <Link href={`/portfolio?copy=${event.strategyId}`} className="text-muted-foreground underline">{t("copyUpdates.copy")} #{event.strategyId}</Link> : null}
          {coin ? <span>{coin}</span> : null}
          {orderId ? <span>{t("trader.tabs.orders")} #{orderId}</span> : null}
          {terminal && reasonKeys.has(reason) ? <span className="text-muted-foreground">{t(`copyAdmin.reasons.${reason}` as MessageKey)}</span> : null}
          {command ? <span className="text-muted-foreground">{command}</span> : null}
          {amount !== null && Number.isFinite(amount) ? <span className="num">{format.usd(amount, { digits: 2 })}</span> : null}
        </div>
        <time dateTime={event.createdAt} className="num text-muted-foreground">{format.dateTime(event.createdAt)}</time>
      </li>;
    })}
  </ol>;
}

/** Only owner-confirmed server events; the cursor feed is independent of
 * leader signals and keeps its last confirmed items on reconnect failure. */
export function CopyActivity() {
  const query = useCopyEvents();
  const { t } = useI18n();
  return <section className="mt-6 orbit-card card-pad" aria-label={t("copyUpdates.activityAria")}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-bold">{t("copyUpdates.activityTitle")} <PaperBadge /></h2>
      <TextButton busy={query.isFetching} onClick={() => void query.refetch()} className="rounded px-2 py-1 text-xs text-muted-foreground no-underline hover:text-foreground">{t("copyUpdates.refresh")}</TextButton>
    </div>
    <p className="mt-2 text-[11px] text-muted-foreground">{t("copyUpdates.activityHint")}</p>
    {query.isError || query.olderError ? <p role="status" className="mt-3 text-xs text-warning">{t("copyUpdates.activityError")}</p> : null}
    {query.data ? <CopyActivityItems items={query.data.items} /> : <p className="py-6 text-center text-xs text-muted-foreground">{query.isPending ? (t("copyUpdates.activityLoading")) : "—"}</p>}
    {query.data?.hasMore ? <button type="button" disabled={query.isLoadingOlder} onClick={() => query.loadOlder()} className="mt-3 rounded px-3 py-2 text-xs text-primary-text disabled:opacity-50">{t("copyUpdates.older")}</button> : null}
  </section>;
}
