"use client";

import Link from "next/link";
import { PaperBadge } from "@/components/copy/paper-badge";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { useCopyEvents } from "@/lib/copy";
import type { WireCopyEvents } from "@trading-dashboard/shared/contracts";

const eventKeys = new Set(["strategy_created", "strategy_command", "funds_added", "funds_withdrawn", "funds_returned", "order_filled", "position_liquidated"]);

export function CopyActivityItems({ items }: { items: WireCopyEvents["items"] }) {
  const { t, format } = useI18n();
  if (!items.length) return <p className="py-6 text-center text-xs text-muted-foreground">{t("copyUpdates.activityEmpty")}</p>;
  return <ol className="mt-2 divide-y divide-border">
    {[...items].reverse().map((event) => {
      const amount = typeof event.payload.amount === "number" || typeof event.payload.amount === "string" ? Number(event.payload.amount) : null;
      const coin = typeof event.payload.coin === "string" ? event.payload.coin : null;
      const command = typeof event.payload.command === "string" ? event.payload.command.replaceAll("_", " ") : null;
      return <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-semibold">{eventKeys.has(event.type) ? t(`copyUpdates.events.${event.type}` as MessageKey) : event.type.replaceAll("_", " ")}</span>
          {event.strategyId !== null ? <Link href={`/portfolio?copy=${event.strategyId}`} className="text-muted-foreground underline">{t("copyUpdates.copy")} #{event.strategyId}</Link> : null}
          {coin ? <span>{coin}</span> : null}
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
  return <section className="mt-6 rounded-2xl border border-border bg-card p-4" aria-label={t("copyUpdates.activityAria")}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-bold">{t("copyUpdates.activityTitle")} <PaperBadge /></h2>
      <button type="button" disabled={query.isFetching} onClick={() => query.refetch()} className="rounded px-2 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{t("copyUpdates.refresh")}</button>
    </div>
    <p className="mt-2 text-[11px] text-muted-foreground">{t("copyUpdates.activityHint")}</p>
    {query.isError || query.olderError ? <p role="status" className="mt-3 text-xs text-warning">{t("copyUpdates.activityError")}</p> : null}
    {query.data ? <CopyActivityItems items={query.data.items} /> : <p className="py-6 text-center text-xs text-muted-foreground">{query.isPending ? (t("copyUpdates.activityLoading")) : "—"}</p>}
    {query.data?.hasMore ? <button type="button" disabled={query.isLoadingOlder} onClick={() => query.loadOlder()} className="mt-3 rounded px-3 py-2 text-xs text-primary disabled:opacity-50">{t("copyUpdates.older")}</button> : null}
  </section>;
}
