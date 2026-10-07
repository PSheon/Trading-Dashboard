"use client";

import { DataList } from "@/components/ui/data-list";


import type { WireCopyEvents } from "@trading-dashboard/shared/contracts";

import { PAGE_SIZE, TablePager, usePaged } from "@/components/ui/table-pager";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { useCopyEvents } from "@/lib/copy";
import { coinLabel } from "@/lib/format";

type CopyEvent = WireCopyEvents["items"][number];
const LABELLED = new Set(["strategy_created", "strategy_command", "funds_added", "funds_withdrawn", "funds_returned", "order_filled", "position_liquidated"]);

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
    return { what: what || "—", who: name ? t("folio.follow", { name }) : null, when: format.clock(event.createdAt) };
  };
}

/**
 * 動態: the copy events of one side of the portfolio (paper, or the real
 * copies), each one line in plain words, ten a page with the one pager (a
 * page past the events read asks for older ones). `names` maps the side's
 * copies (strategy id → trader name); events of other copies are left out,
 * so paper and real money never share a list. Copy activity only: deposits
 * and withdrawals are in 交易紀錄, and the empty line says so.
 */
export function CopyActivity({ names, className }: { names: Map<number, string>; className?: string }) {
  const { t } = useI18n();
  const query = useCopyEvents();
  const line = useEventLine();
  const mine = (query.data?.items ?? []).filter((event) => event.strategyId !== null && names.has(event.strategyId)).reverse();
  const { rows: page, pager } = usePaged(mine);
  const more = Boolean(query.data?.hasMore);
  const onPage = (next: number) => {
    if ((next + 1) * PAGE_SIZE > mine.length && more && !query.isLoadingOlder) query.loadOlder();
    pager.onPage(next);
  };
  return (
    <div className={className} data-testid="copy-activity">
      {mine.length ? (
        <DataList as="ol" className="" data-testid="recent-activity">
          {page.map((event) => {
            const { what, who, when } = line(event, names.get(event.strategyId!));
            return (
              <li key={event.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate"><span className="font-semibold">{what}</span>{who ? <span className="text-muted-foreground"> · {who}</span> : null}</span>
                <time dateTime={event.createdAt} className="num shrink-0 text-xs text-muted-foreground">{when}</time>
              </li>
            );
          })}
        </DataList>
      ) : (
        <p className="py-4 text-sm text-muted-foreground">{query.isPending && !query.data ? t("copyUpdates.activityLoading") : t("folio.noCopyActivity")}</p>
      )}
      <TablePager page={pager.page} hasNext={pager.page + 1 < pager.pages || (more && mine.length > 0)} busy={query.isLoadingOlder} onPage={onPage} className="px-0" />
    </div>
  );
}
