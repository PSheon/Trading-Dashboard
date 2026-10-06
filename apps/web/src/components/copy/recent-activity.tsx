"use client";

import { useState } from "react";
import { cn } from "cn";
import type { WireCopyEvents } from "@trading-dashboard/shared/contracts";

import { Modal } from "@/components/ui/dialog";
import { TextButton } from "@/components/ui/text-button";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { useCopyEvents } from "@/lib/copy";
import { coinLabel } from "@/lib/format";

type CopyEvent = WireCopyEvents["items"][number];
const LABELLED = new Set(["strategy_created", "strategy_command", "funds_added", "funds_withdrawn", "funds_returned", "order_filled", "position_liquidated"]);
const RECENT = 5;

/** One event in plain words: 「ETH 買入 0.5 · 跟 solanadoomer · 23:10」. No
 * copy number, order id or code (web audit §五 4). */
export function useEventLine() {
  const { t, format } = useI18n();
  return (event: CopyEvent, name: string | undefined) => {
    const coin = typeof event.payload.coin === "string" ? coinLabel(event.payload.coin) : null;
    const side = event.payload.side === "B" || event.payload.side === "buy" ? t("folio.buy") : event.payload.side === "A" || event.payload.side === "sell" ? t("folio.sell") : null;
    const size = typeof event.payload.size === "string" || typeof event.payload.size === "number" ? String(event.payload.size) : null;
    const amount = typeof event.payload.amount === "number" || typeof event.payload.amount === "string" ? Number(event.payload.amount) : null;
    const what = event.type === "order_filled" && coin && side
      ? [coin, side, size].filter(Boolean).join(" ")
      : [LABELLED.has(event.type) ? t(`copyUpdates.events.${event.type}` as MessageKey) : event.type === "order_rejected" ? t("copyUpdates.orderRejected") : event.type === "order_cancelled" ? t("copyUpdates.orderCancelled") : null,
        coin, amount !== null && Number.isFinite(amount) ? format.usd(amount, { digits: 2 }) : null].filter(Boolean).join(" ");
    const at = new Date(event.createdAt), today = new Date().toDateString() === at.toDateString();
    return { what: what || "—", who: name ? t("folio.follow", { name }) : null, when: today ? format.time(event.createdAt) : `${format.shortDate(event.createdAt)} ${format.time(event.createdAt)}` };
  };
}

/**
 * 最近活動: the last five events of one side of the portfolio (paper, or the
 * real copies), each one line in plain words, then 查看全部. `names` maps the
 * side's copies (strategy id → trader name); events of other copies are left
 * out, so paper and real money never share a list.
 */
export function RecentActivity({ names, className }: { names: Map<number, string>; className?: string }) {
  const { t } = useI18n();
  const query = useCopyEvents();
  const line = useEventLine();
  const [all, setAll] = useState(false);
  const mine = (query.data?.items ?? []).filter((event) => event.strategyId !== null && names.has(event.strategyId)).reverse();
  const row = (event: CopyEvent) => {
    const { what, who, when } = line(event, names.get(event.strategyId!));
    return (
      <li key={event.id} className="flex items-center gap-3 py-2.5 text-sm">
        <span className="min-w-0 flex-1 truncate"><span className="font-semibold">{what}</span>{who ? <span className="text-muted-foreground"> · {who}</span> : null}</span>
        <time dateTime={event.createdAt} className="num shrink-0 text-xs text-muted-foreground">{when}</time>
      </li>
    );
  };
  return (
    <section className={cn("orbit-card card-pad", className)} aria-label={t("folio.recent")}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[0.9375rem] font-extrabold">{t("folio.recent")}</h2>
        {mine.length > RECENT ? <TextButton onClick={() => setAll(true)} className="text-sm">{t("folio.seeAll")}</TextButton> : null}
      </div>
      {mine.length ? <ol className="mt-1 divide-y-2 divide-dotted divide-border" data-testid="recent-activity">{mine.slice(0, RECENT).map(row)}</ol>
        : <p className="py-4 text-sm text-muted-foreground">{query.isPending && !query.data ? t("copyUpdates.activityLoading") : t("folio.noActivity")}</p>}
      <Modal open={all} onOpenChange={setAll} title={t("folio.allActivity")}>
        <div className="px-6 pb-6">
          <ol className="divide-y-2 divide-dotted divide-border">{mine.map(row)}</ol>
          {query.data?.hasMore ? <TextButton busy={query.isLoadingOlder} onClick={() => query.loadOlder()} className="mt-3 text-sm">{t("folio.more")}</TextButton> : null}
        </div>
      </Modal>
    </section>
  );
}
