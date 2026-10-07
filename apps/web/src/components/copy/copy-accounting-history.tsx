"use client";

import { DataList } from "@/components/ui/data-list";


import { copyRecordLabel } from "./copy-labels";
import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { wireCopyLedgerSchema, wireCopyFillsSchema, type WireCopyFills, type WireCopyLedger } from "@trading-dashboard/shared/contracts";
import { cn } from "cn";

import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { api, sessionKey } from "@/lib/api";
import { coinLabel } from "@/lib/format";
import { defaultRetry } from "@/lib/query-policy";
import { TextButton } from "@/components/ui/text-button";
import { PAGE_SIZE, TablePager, usePaged } from "@/components/ui/table-pager";

/**
 * A paper copy's history in two parts (Paul, 2026-10-07, audit §十三):
 * 訂單 (the orders table; a row opens its fills with the order's fees and
 * realized PnL, read here by order id) and 資金紀錄 (the ledger rows of no
 * order: 資金分配, 資金退回, 提款, 資金費, 清算). No raw decimals, no ids.
 *
 * The api pages fills and the ledger newest first by id, 100 at a time;
 * the pages needed for an order (or for a page of 資金紀錄) are read on
 * demand. A paper copy's history is small, so this stays a few requests.
 */
const SCAN = 100;
/** At most this many pages are read for one order's fills. */
const MAX_SCAN_PAGES = 10;

type Fill = WireCopyFills["items"][number];
type LedgerRow = WireCopyLedger["items"][number];

function useHistoryPages<K extends "ledger" | "fills">(strategyId: number, kind: K, enabled: boolean) {
  const { status, identity, mode } = useAuth();
  return useInfiniteQuery({
    queryKey: ["copy", "history", identity, mode, sessionKey(), strategyId, kind],
    queryFn: async ({ pageParam, signal }) => {
      const data = await api.get<unknown>(`/me/copy/strategies/${strategyId}/${kind}?limit=${SCAN}${pageParam ? `&before=${pageParam}` : ""}`, signal);
      return (kind === "ledger" ? wireCopyLedgerSchema.parse(data) : wireCopyFillsSchema.parse(data)) as K extends "ledger" ? WireCopyLedger : WireCopyFills;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.previousCursor ? last.previousCursor : undefined),
    enabled: enabled && status === "signedIn",
    ...defaultRetry,
  });
}

const older = (a: string, b: string) => BigInt(a) < BigInt(b);

/** An order's fills, and their fees and realized PnL, as its row opens. */
export function OrderFills({ strategyId, orderId }: { strategyId: number; orderId: string }) {
  const { t, format } = useI18n();
  const query = useHistoryPages(strategyId, "fills", true);
  const all = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  // Fills come newest first: past one of an older order, this one's are all in.
  const covered = all.some((f) => older(f.orderId, orderId)) || (query.data !== undefined && !query.hasNextPage);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const pages = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (!covered && hasNextPage && !isFetchingNextPage && pages < MAX_SCAN_PAGES) void fetchNextPage();
  }, [covered, hasNextPage, isFetchingNextPage, pages, fetchNextPage]);
  const fills: Fill[] = all.filter((f) => f.orderId === orderId);
  const { rows: fillRows, pager: fillsPager } = usePaged(fills, `${strategyId}:${orderId}`);
  if (query.isError && !query.data) return <p role="alert" className="text-xs text-negative">{t("copyUpdates.historyError")} <TextButton busy={query.isFetching} onClick={() => void query.refetch()}>{t("copyUpdates.retry")}</TextButton></p>;
  if (!covered && (query.isPending || isFetchingNextPage || hasNextPage)) return <p role="status" className="text-xs font-semibold text-muted-foreground">{t("common.loading")}</p>;
  if (!fills.length) return <p className="text-xs font-semibold text-muted-foreground">{t("portfolio.copy.detail.noFills")}</p>;
  const fees = fills.reduce((sum, f) => sum + Number(f.fee) + Number(f.builderFee), 0);
  const realized = fills.reduce((sum, f) => sum + Number(f.realizedPnl), 0);
  return (
    <div className="flex flex-col gap-2" data-testid="order-fills">
      <p className="type-th">{t("portfolio.copy.detail.orderFills")}</p>
      <DataList className="flex flex-col text-xs">
        {fillRows.map((f) => (
          <li key={f.id} className="num flex items-center justify-between gap-3 py-1.5">
            <span className="font-semibold">{format.num(Number(f.size), 5)} × {format.price(Number(f.px))}</span>
            <time dateTime={f.ts} className="text-muted-foreground">{format.dateTime(f.ts)}</time>
          </li>
        ))}
      </DataList>
      <TablePager {...fillsPager} />
      <dl className="num flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex gap-2"><dt className="text-muted-foreground">{t("portfolio.copy.detail.orderFees")}</dt><dd className="font-semibold">{format.usd(-fees, { digits: 2 })}</dd></div>
        <div className="flex gap-2"><dt className="text-muted-foreground">{t("portfolio.copy.detail.orderRealized")}</dt><dd className={cn("font-semibold", realized > 0 ? "text-positive" : realized < 0 ? "text-negative" : "")}>{format.usd(realized, { sign: true, digits: 2 })}</dd></div>
      </dl>
    </div>
  );
}

/** 資金紀錄: the copy's money moves that belong to no order, ten a page. */
export function CopyFundsRecords({ strategyId }: { strategyId: number }) {
  const { t, format } = useI18n();
  const query = useHistoryPages(strategyId, "ledger", true);
  const rows: LedgerRow[] = useMemo(() => (query.data?.pages.flatMap((p) => p.items) ?? []).filter((row) => row.orderId === null), [query.data]);
  const { rows: page, pager } = usePaged(rows);
  const onPage = (next: number) => {
    if ((next + 1) * PAGE_SIZE > rows.length && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    pager.onPage(next);
  };
  return (
    <section className="orbit-card" aria-label={t("portfolio.copy.detail.fundsTitle")} data-testid="copy-funds-records">
      <h3 className="border-b-2 border-dotted border-border px-4 py-3 text-sm font-bold">{t("portfolio.copy.detail.fundsTitle")}</h3>
      {query.isError && !query.data ? (
        <p role="alert" className="px-4 py-3 text-xs text-negative">{t("copyUpdates.historyError")} <TextButton busy={query.isFetching} onClick={() => void query.refetch()}>{t("copyUpdates.retry")}</TextButton></p>
      ) : !query.data ? (
        <p role="status" className="px-4 py-3 text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : rows.length === 0 && !query.hasNextPage ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t("portfolio.copy.detail.noFunds")}</p>
      ) : (
        <DataList className="flex flex-col px-4">
          {page.map((row) => {
            const amount = Number(row.amount);
            return (
              <li key={row.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold">{copyRecordLabel("ledgerKinds", row.kind, t)}{row.coin ? ` · ${coinLabel(row.coin)}` : ""}</p>
                  <time className="text-xs text-muted-foreground" dateTime={row.createdAt}>{format.dateTime(row.createdAt)}</time>
                </div>
                <span className={cn("num shrink-0 font-bold", amount > 0 ? "text-positive" : "text-foreground")}>{format.usd(amount, { sign: true, digits: 2 })}</span>
              </li>
            );
          })}
        </DataList>
      )}
      <TablePager page={pager.page} hasNext={pager.page + 1 < pager.pages || Boolean(query.hasNextPage)} busy={query.isFetchingNextPage} onPage={onPage} />
    </section>
  );
}
