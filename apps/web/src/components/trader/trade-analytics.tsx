"use client";

import type { RoundTrip, TradeCoin, TraderAnalyticsResponse } from "@/lib/contracts";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { EmptyState, ErrorState, Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { coinLabel } from "@/lib/format";
import { isComputing, useTraderTrades, type TradeStatusFilter } from "@/lib/queries";

/** The api is rebuilding a cold address's trades from Hyperliquid. */
export function ComputingState({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <p
      role="status"
      className={cn(
        "flex items-center gap-2 text-muted-foreground",
        compact ? "text-xs" : "justify-center px-6 py-10 text-[0.8125rem]",
      )}
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      {t(compact ? "trader.computingShort" : "trader.computing")}
    </p>
  );
}

/** "Based on trades since …" when older history isn't included. */
export function CoverageNote({ analytics, className }: { analytics: Pick<TraderAnalyticsResponse, "coverage">; className?: string }) {
  const { t, format } = useI18n();
  const { coverage } = analytics;
  if (!coverage.truncated || coverage.from === null) return null;
  return (
    <p className={cn("text-[11px] leading-relaxed text-subtle-foreground", className)} title={t("trader.coverageHint")}>
      {t("trader.coverageSince", { date: format.date(coverage.from) })}
    </p>
  );
}

function SideBadge({ side }: { side: RoundTrip["side"] }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
        side === "long" ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative",
      )}
    >
      {side === "long" ? t("common.long") : t("common.short")}
    </span>
  );
}

function Pnl({ value, className }: { value: number; className?: string }) {
  const { format } = useI18n();
  return (
    <span className={cn("font-semibold", value > 0 ? "text-positive" : value < 0 ? "text-negative" : "", className)}>
      {format.usd(value, { sign: true, compact: Math.abs(value) >= 1e5 })}
    </span>
  );
}

function AssetCell({ coin }: { coin: string }) {
  return (
    <span className="flex items-center gap-2 font-semibold">
      <CoinIcon coin={coin} size={18} />
      {coinLabel(coin)}
    </span>
  );
}

/** Entry price (≈ when estimated) over its time ("before …" when partial). */
function EntryCell({ trade, withTime }: { trade: RoundTrip; withTime: boolean }) {
  const { t, format } = useI18n();
  return (
    <>
      <span title={trade.entryApprox ? t("trader.entryApproxHint") : undefined}>
        {trade.entryApprox ? "≈" : ""}
        {format.price(trade.entryPx)}
      </span>
      {withTime ? (
        <div className="num text-[11px] text-subtle-foreground" title={trade.partial ? t("trader.partialHint") : undefined}>
          {trade.partial ? t("trader.partialBefore", { time: format.dateTime(trade.entryTime) }) : format.dateTime(trade.entryTime)}
        </div>
      ) : null}
    </>
  );
}

function Duration({ trade }: { trade: RoundTrip }) {
  const { format } = useI18n();
  return (
    <>
      {trade.partial ? ">" : ""}
      {format.duration(trade.holdSeconds)}
    </>
  );
}

/** Best or worst closed trades: 資產 / 買賣 / 進場價 / 出場價 / 持續時間 / 日期 / 損益. */
function TradeList({ rows }: { rows: RoundTrip[] }) {
  const { t, format } = useI18n();
  if (rows.length === 0) return <EmptyState title={t("trader.noClosedTrades")} />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("trader.tradeCols.asset")}</TableHead>
          <TableHead>{t("trader.tradeCols.side")}</TableHead>
          <TableHead className="text-right">{t("trader.tradeCols.entry")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("trader.tradeCols.exit")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("trader.tradeCols.duration")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("trader.tradeCols.date")}</TableHead>
          <TableHead className="text-right">{t("trader.tradeCols.pnl")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((trade) => (
          <TableRow key={trade.id}>
            <TableCell>
              <AssetCell coin={trade.coin} />
            </TableCell>
            <TableCell>
              <SideBadge side={trade.side} />
            </TableCell>
            <TableCell className="text-right">
              <EntryCell trade={trade} withTime={false} />
            </TableCell>
            <TableCell className="hidden text-right sm:table-cell">{format.price(trade.exitPx)}</TableCell>
            <TableCell className="hidden text-right text-muted-foreground md:table-cell">
              <Duration trade={trade} />
            </TableCell>
            <TableCell className="num hidden text-right font-mono text-xs text-muted-foreground md:table-cell">
              {format.dateTime(trade.exitTime)}
            </TableCell>
            <TableCell className="text-right">
              <Pnl value={trade.netPnl} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** CopyDog's per-asset table: 資產 / 交易 (wins–losses) / 勝率 / 交易量 / 損益. */
function CoinList({ rows }: { rows: TradeCoin[] }) {
  const { t, format } = useI18n();
  if (rows.length === 0) return <EmptyState title={t("trader.noClosedTrades")} />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("trader.tradeCols.asset")}</TableHead>
          <TableHead className="text-right">{t("trader.tradeCols.trades")}</TableHead>
          <TableHead className="text-right">{t("trader.tradeCols.winRate")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("trader.tradeCols.volume")}</TableHead>
          <TableHead className="text-right">{t("trader.tradeCols.pnl")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((coin) => (
          <TableRow key={coin.coin}>
            <TableCell>
              <AssetCell coin={coin.coin} />
            </TableCell>
            <TableCell className="text-right">
              <span className="num">
                {coin.trades}{" "}
                <span className="text-[11px] text-subtle-foreground">
                  (<span className="text-positive">{coin.wins}</span>/<span className="text-negative">{coin.losses}</span>)
                </span>
              </span>
            </TableCell>
            <TableCell className="text-right">{format.pct(coin.winRate)}</TableCell>
            <TableCell className="hidden text-right sm:table-cell">{format.usd(coin.volume, { compact: true })}</TableCell>
            <TableCell className="text-right">
              <Pnl value={coin.netPnl} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type PerfView = "best" | "worst" | "coins";

/** 表現: best / worst closed trades and the per-coin table (all-time, as on
 * CopyDog's performance tab). */
export function PerformanceTab({
  analytics,
  computing,
  error,
  onRetry,
}: {
  analytics: TraderAnalyticsResponse | undefined;
  computing: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<PerfView>("best");
  if (!analytics) {
    if (computing) return <ComputingState />;
    return <ErrorState message={error?.message ?? t("trader.analyticsFailed")} onRetry={onRetry} />;
  }
  const { summary } = analytics;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <Segmented
          value={view}
          onChange={setView}
          variant="pill"
          label={t("trader.tabs.performance")}
          options={[
            { value: "best", label: t("trader.perf.best") },
            { value: "worst", label: t("trader.perf.worst") },
            { value: "coins", label: t("trader.perf.mostTraded") },
          ]}
        />
        <CoverageNote analytics={analytics} />
      </div>
      {view === "best" ? <TradeList rows={summary.best} /> : null}
      {view === "worst" ? <TradeList rows={summary.worst} /> : null}
      {view === "coins" ? <CoinList rows={summary.coins} /> : null}
    </div>
  );
}

/** 交易: the round-trip ledger with All / Closed / Open and "show more". Net
 * PnL includes funding, as CopyDog shows it. */
export function TradesTab({ address }: { address: string }) {
  const { t, format } = useI18n();
  const [status, setStatus] = useState<TradeStatusFilter>("all");
  const query = useTraderTrades(address, status);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const coverage = query.data?.pages[0];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <Segmented
          value={status}
          onChange={setStatus}
          variant="pill"
          label={t("trader.tabs.trades")}
          options={[
            { value: "all", label: t("trader.tradeFilters.all") },
            { value: "closed", label: t("trader.tradeFilters.closed") },
            { value: "open", label: t("trader.tradeFilters.open") },
          ]}
        />
        {coverage ? <CoverageNote analytics={coverage} /> : null}
      </div>
      {query.isError ? (
        <ErrorState message={query.error.message} onRetry={() => query.refetch()} />
      ) : !query.data ? (
        isComputing(query) && query.failureReason ? (
          <ComputingState />
        ) : (
          <div className="flex flex-col gap-2 p-5">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        )
      ) : rows.length === 0 ? (
        <EmptyState title={t("trader.noClosedTrades")} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("trader.tradeCols.asset")}</TableHead>
                <TableHead>{t("trader.tradeCols.side")}</TableHead>
                <TableHead className="text-right">{t("trader.tradeCols.entry")}</TableHead>
                <TableHead className="text-right">{t("trader.tradeCols.exit")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("trader.tradeCols.notional")}</TableHead>
                <TableHead className="hidden text-right sm:table-cell">{t("trader.tradeCols.duration")}</TableHead>
                <TableHead className="hidden text-right lg:table-cell">{t("trader.tradeCols.funding")}</TableHead>
                <TableHead className="text-right">{t("trader.tradeCols.netPnl")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((trade) => (
                <TableRow key={trade.id} data-status={trade.status}>
                  <TableCell>
                    <AssetCell coin={trade.coin} />
                  </TableCell>
                  <TableCell>
                    <SideBadge side={trade.side} />
                  </TableCell>
                  <TableCell className="text-right">
                    <EntryCell trade={trade} withTime />
                  </TableCell>
                  <TableCell className="text-right">
                    {trade.exitPx === null ? "—" : format.price(trade.exitPx)}
                    <div className="num text-[11px] text-subtle-foreground">
                      {trade.exitTime === null ? t("trader.tradeFilters.open") : format.dateTime(trade.exitTime)}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right md:table-cell">{format.usd(trade.notional, { compact: true })}</TableCell>
                  <TableCell className="hidden text-right text-muted-foreground sm:table-cell">
                    <Duration trade={trade} />
                  </TableCell>
                  <TableCell className="hidden text-right lg:table-cell">
                    {trade.funding === null ? (
                      <span className="text-subtle-foreground">—</span>
                    ) : (
                      <Pnl value={trade.funding} className="font-normal" />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Pnl value={trade.netPnl + (trade.funding ?? 0)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {query.hasNextPage ? (
            <div className="flex justify-center border-t border-border p-3">
              <Button variant="ghost" size="sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
                {query.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
                {t("trader.showMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
