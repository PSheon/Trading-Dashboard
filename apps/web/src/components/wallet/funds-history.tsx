"use client";

import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Coins, ReceiptText } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { PaperBadge } from "@/components/copy/paper-badge";
import { EmptyState, ErrorState, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { useFundsHistory, mergeFunds, rowMatches, type FundsFilter, type FundsRow } from "@/lib/funds";
import { truncateAddress } from "@/lib/format";
import { useWalletHistory } from "@/lib/wallet";
import { ICON, WithdrawalNotices, kindOf } from "./history-list";

const FILTERS: FundsFilter[] = ["all", "transfers", "copies", "fees"];

/**
 * One money-flow history (B13/B14): the hub wallet's deposits, withdrawals
 * and transfers (Hyperliquid's ledger) with what Orbie records — money moved
 * into and out of each copy, each copy's fees and funding per day, hub →
 * copy-wallet funding (folded with its on-chain hub transfer) and the hub
 * withdrawals Orbie submitted. Paper copies move simulated funds and say so.
 */
export function FundsHistory({ className }: { className?: string }) {
  const { t, format } = useI18n();
  const hub = useWalletHistory();
  const flows = useFundsHistory();
  const [filter, setFilter] = useState<FundsFilter>("all");
  const items = useMemo(() => flows.data?.pages.flatMap((p) => p.items) ?? [], [flows.data]);
  const rows = useMemo(() => mergeFunds(hub.data?.transfers, items, !flows.hasNextPage), [hub.data, items, flows.hasNextPage]);
  const shown = rows.filter((r) => rowMatches(r, filter));
  const loading = (!hub.data && hub.isPending) || (!flows.data && flows.isPending);
  return (
    <div className={className}>
      <WithdrawalNotices />
      <div role="radiogroup" aria-label={t("funds.title")} className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
            className={cn("h-8 rounded-full px-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", filter === f ? "bg-primary text-primary-foreground" : "bg-raised text-foreground")}>
            {t(`funds.filters.${f}`)}
          </button>
        ))}
      </div>
      {hub.data?.from && hub.data.fetchedAt ? <p className="mb-2 text-xs text-muted-foreground">{t("wallet.historyCoverage", { from: format.dateTime(hub.data.from), time: format.dateTime(hub.data.fetchedAt) })}</p> : null}
      {hub.isError ? <ErrorState onRetry={() => void hub.refetch()} /> : null}
      {flows.isError ? <ErrorState onRetry={() => void flows.refetch()} /> : null}
      {loading ? (
        <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState icon={ReceiptText} title={t("funds.empty")} body={t("wallet.historyEmptyBody")} />
      ) : (
        <ul className="divide-y-2 divide-dotted divide-border" data-testid="funds-history">
          {shown.map((row) => <Row key={row.id} row={row} />)}
        </ul>
      )}
      {flows.hasNextPage ? (
        <Button variant="secondary" size="sm" className="mt-3" disabled={flows.isFetchingNextPage} onClick={() => void flows.fetchNextPage()}>{t("funds.older")}</Button>
      ) : null}
    </div>
  );
}

function Row({ row }: { row: FundsRow }) {
  const { t, format } = useI18n();
  if (row.source === "hub") {
    const kind = kindOf(row.transfer);
    const Icon = ICON[kind];
    const sign = row.transfer.direction === "in" ? "+" : row.transfer.direction === "out" ? "−" : "";
    return (
      <li className="flex items-center gap-3 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-muted-foreground"><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t(`wallet.historyKinds.${kind}` as MessageKey)}</p>
          <p className="text-xs text-muted-foreground">{t("funds.hub")} · {format.dateTime(row.time)}</p>
        </div>
        <span className={cn("num text-sm font-semibold", row.transfer.direction === "in" ? "text-positive" : row.transfer.direction === "out" ? "text-foreground" : "text-muted-foreground")}>
          {sign}{format.num(row.transfer.amount, 2)} {row.transfer.usd ? "USD" : row.transfer.token}
        </span>
      </li>
    );
  }
  const f = row.flow;
  const id = f.strategyId ?? 0;
  const label = t(`funds.kinds.${f.kind}` as MessageKey, { id, count: f.count ?? 0 });
  const Icon = f.kind === "fees" || f.kind === "funding" ? Coins : f.kind === "copy_funding" || f.kind === "copy_deposit" ? ArrowLeftRight : f.amount >= 0 ? ArrowDownLeft : ArrowUpRight;
  const route = f.kind === "copy_funding" ? t("funds.routeHubToCopy", { id }) : f.mode === "paper" && f.counterparty === "paper" ? (f.amount >= 0 ? t("funds.routePaperToCopy", { id }) : t("funds.routeCopyToPaper", { id })) : null;
  return (
    <li className="flex items-center gap-3 py-3">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", f.kind === "fees" ? "bg-raised text-muted-foreground" : "bg-tag-alert text-tag-alert-foreground")}><Icon className="size-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">{label}{f.mode === "paper" ? <PaperBadge /> : null}{f.status ? <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{t(`funds.status.${f.status}` as MessageKey)}</span> : null}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[route, f.leaderAddress ? truncateAddress(f.leaderAddress) : null, format.dateTime(row.time)].filter(Boolean).join(" · ")}
        </p>
        {row.hubHash ? <p className="truncate font-mono text-[11px] text-subtle-foreground">{t("funds.receipt", { hash: truncateAddress(row.hubHash) })}</p> : null}
        {f.fee ? <p className="text-[11px] text-subtle-foreground">{t("funds.transferFee", { fee: format.usd(f.fee, { digits: 2 }) })}</p> : null}
      </div>
      <span className={cn("num text-sm font-semibold", f.amount > 0 ? "text-positive" : "text-foreground")}>{format.usd(f.amount, { sign: true, digits: 2 })}</span>
    </li>
  );
}
