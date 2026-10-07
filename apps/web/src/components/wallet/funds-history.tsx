"use client";

import { DataList } from "@/components/ui/data-list";


import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Coins, ReceiptText } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";

import { EmptyState, ErrorState, ListRowsSkeleton } from "@/components/page";
import { PAGE_SIZE, TablePager, usePaged } from "@/components/ui/table-pager";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { useFundsHistory, isReturnFlow, mergeFunds, rowMatches, walletAmount, type FundsFilter, type FundsRow } from "@/lib/funds";
import { truncateAddress } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useLeaders } from "@/components/copy/copy-portfolio";
import { boardName } from "@/components/discover/board-bits";
import { useWalletHistory } from "@/lib/wallet";
import { useLiveCopyDeployment } from "@/lib/copy-live-setup";
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
  const { t } = useI18n();
  const owner = useAuth().wallet?.address ?? null;
  const hub = useWalletHistory();
  const flows = useFundsHistory();
  const [filter, setFilter] = useState<FundsFilter>("all");
  const ownerFilter = `${owner}:${filter}`;
  const currentFilter = useRef(ownerFilter);
  useLayoutEffect(() => { currentFilter.current = ownerFilter; }, [ownerFilter]);
  const [readingOlder, setReadingOlder] = useState(false);
  const items = useMemo(() => flows.data?.pages.flatMap((p) => p.items) ?? [], [flows.data]);
  const rows = useMemo(() => mergeFunds(hub.data?.transfers, items, !flows.hasNextPage, owner), [hub.data, items, flows.hasNextPage, owner]);
  // Each copy by its trader's name, not "#id".
  const leaders = useLeaders(useMemo(() => items.flatMap((f) => (f.leaderAddress ? [{ leaderAddress: f.leaderAddress.toLowerCase() }] : [])), [items]));
  const nameOf = (address: string | null) => (address ? boardName(leaders.get(address.toLowerCase()) ?? { address, displayName: null }) : "—");
  const shown = rows.filter((r) => rowMatches(r, filter));
  const { rows: pageRows, pager } = usePaged(shown, ownerFilter);
  // This deployment's network: another network's money (Stage's testnet
  // copies after the move to mainnet) is tagged with its network, never
  // read as this one's (Stage A1).
  const network = useLiveCopyDeployment()?.network ?? null;
  const loading = (!hub.data && hub.isPending) || (!flows.data && flows.isPending);
  return (
    <div className={className}>
      <WithdrawalNotices />
      <div role="radiogroup" aria-label={t("funds.title")} className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
            className={cn("min-h-11 rounded-full px-4 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", filter === f ? "bg-primary text-primary-foreground" : "bg-raised text-foreground")}>
            {t(`funds.filters.${f}`)}
          </button>
        ))}
      </div>
      {hub.isError ? <ErrorState onRetry={() => void hub.refetch()} /> : null}
      {flows.isError ? <ErrorState onRetry={() => void flows.refetch()} /> : null}
      {loading ? (
        <ListRowsSkeleton />
      ) : shown.length === 0 ? (
        <EmptyState icon={ReceiptText} title={t("funds.empty")} body={t("wallet.historyEmptyBody")} />
      ) : (
        <DataList data-testid="funds-history">
          {pageRows.map((row) => <Row key={row.id} row={row} owner={owner} nameOf={nameOf} network={network} />)}
        </DataList>
      )}
      <TablePager {...pager} pages={flows.hasNextPage ? undefined : pager.pages} hasNext={pager.page + 1 < pager.pages || Boolean(flows.hasNextPage && !flows.isError)} busy={readingOlder || flows.isFetchingNextPage}
        onPage={async (next) => {
          if (next * PAGE_SIZE < shown.length || !flows.hasNextPage) { pager.onPage(next); return; }
          setReadingOlder(true);
          try {
            // A filtered API page may contain no matching rows. Continue until
            // the requested UI page has a row, or the server has no older data.
            let result;
            do {
              result = await flows.fetchNextPage({ cancelRefetch: false });
              if (result.isFetchNextPageError || currentFilter.current !== ownerFilter) return;
              const fetched = result.data?.pages.flatMap((p) => p.items) ?? [];
              const count = mergeFunds(hub.data?.transfers, fetched, !result.hasNextPage, owner).filter((row) => rowMatches(row, filter)).length;
              if (count > next * PAGE_SIZE) break;
            } while (result.hasNextPage);
            pager.onPage(next);
          } finally { setReadingOlder(false); }
        }} />
    </div>
  );
}

function Row({ row, owner, nameOf, network }: { row: FundsRow; owner: string | null; nameOf: (address: string | null) => string; network: string | null }) {
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
  const name = nameOf(f.leaderAddress);
  // Signed as the owner's wallet (or paper account) sees it: in +, out −.
  const amount = walletAmount(f, owner), back = isReturnFlow(f, owner);
  const label = t(`funds.kinds.${back ? "copy_return" : f.kind}` as MessageKey, { name, count: f.count ?? 0 });
  const Icon = f.kind === "fees" || f.kind === "funding" ? Coins : f.kind === "copy_funding" || f.kind === "copy_deposit" ? ArrowLeftRight : amount >= 0 ? ArrowDownLeft : ArrowUpRight;
  const route = f.kind === "copy_funding" ? t(back ? "funds.routeCopyToHub" : "funds.routeHubToCopy", { name }) : f.mode === "paper" && f.counterparty === "paper" ? (f.amount >= 0 ? t("funds.routePaperToCopy", { name }) : t("funds.routeCopyToPaper", { name })) : null;
  return (
    <li className="flex items-center gap-3 py-3">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", f.kind === "fees" ? "bg-raised text-muted-foreground" : "bg-tag-alert text-tag-alert-foreground")}><Icon className="size-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">{label}{f.mode === "paper" ? <span className="rounded-full bg-tag-warning px-2 py-0.5 text-[11px] font-semibold text-tag-warning-foreground" data-testid="paper-tag">{t("mode.paper")}</span> : null}{f.mode !== "paper" && network && f.mode !== network ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary-text" data-testid="network-tag">{t(f.mode === "testnet" ? "mode.testnet" : "mode.live")}</span> : null}{f.status ? <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{t(`funds.status.${f.status}` as MessageKey)}</span> : null}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[route, format.dateTime(row.time)].filter(Boolean).join(" · ")}
        </p>
        {row.hubHash ? <p className="truncate font-mono text-[11px] text-subtle-foreground">{t("funds.receipt", { hash: truncateAddress(row.hubHash) })}</p> : null}
        {f.fee ? <p className="text-[11px] text-subtle-foreground">{t("funds.transferFee", { fee: format.usd(f.fee, { digits: 2 }) })}</p> : null}
      </div>
      {/* Another network's amount is not this wallet's money: muted. */}
      <span className={cn("num text-sm font-semibold", f.mode !== "paper" && network && f.mode !== network ? "text-muted-foreground" : amount > 0 ? "text-positive" : "text-foreground")}>{format.usd(amount, { sign: true, digits: 2 })}</span>
    </li>
  );
}
