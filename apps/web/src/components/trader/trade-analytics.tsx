"use client";

import type { RoundTrip, TradeCoin, TraderAnalyticsResponse, TraderTradesResponse } from "@/lib/contracts";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, Share2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { coinLabel } from "@/lib/format";
import { isComputing, useTraderTrades, type TradeStatusFilter } from "@/lib/queries";
import {
  ago,
  duration,
  pct1,
  pnlTone,
  price,
  shortTime,
  signedUsd2,
  signedUsdShort,
  tradeReturnPct,
  usd2,
  winRateTone,
} from "@/lib/trade-format";

/**
 * The 表現 and 交易 tabs, laid out as CopyDog's (its bundle's performance
 * and trades tables, and its mobile trade cards below `sm`): same columns,
 * formats ("Sep 19, 06:52", "20d 17h", "+$54.05K"), sortable headers, empty
 * and computing states. Orbie's palette.
 */

export const TONE_CLASS = { positive: "text-positive", warning: "text-warning", negative: "text-negative" } as const;

/** PnL as CopyDog's tables show it: net + funding. */
const shownPnl = (t: RoundTrip) => t.netPnl + (t.funding ?? 0);

// --- shared states -------------------------------------------------------------

function Computing() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 p-5" role="status">
      <p className="text-center text-xs text-muted-foreground">{t("trader.computing")}</p>
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2 p-5">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <p className="py-12 text-center text-sm text-muted-foreground">
      {t("trader.analyticsFailed")}{" "}
      <button type="button" className="text-primary underline" onClick={onRetry}>
        {t("trader.retry")}
      </button>
    </p>
  );
}

function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {body ? <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{body}</p> : null}
    </div>
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

// --- sortable headers ----------------------------------------------------------

type Dir = "asc" | "desc";

function useSorted<T, K extends string>(rows: T[], keys: Record<K, (row: T) => number | string>, initial: { key: K; dir: Dir }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const get = keys[sort.key];
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const cmp = typeof x === "string" ? String(x).localeCompare(String(y)) : (x as number) - (y as number);
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, keys, sort]);
  const onSort = (key: K) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  return { sorted, sort, onSort };
}

function SortHead<K extends string>({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string;
  col: K;
  sort: { key: K; dir: Dir };
  onSort: (key: K) => void;
  className?: string;
}) {
  const active = sort.key === col;
  return (
    <TableHead className={className} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex items-center gap-0.5 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          active && "font-semibold text-foreground",
        )}
      >
        {label}
      </button>
    </TableHead>
  );
}

// --- cells -------------------------------------------------------------------------

/** "Long" / "Short" badge (English on desktop, as on CopyDog). */
function SideBadge({ side, mobile = false }: { side: RoundTrip["side"]; mobile?: boolean }) {
  const { t } = useI18n();
  const long = side === "long";
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[11px] font-semibold",
        long ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative",
      )}
    >
      {mobile ? t(long ? "trader.sideLong" : "trader.sideShort") : long ? "Long" : "Short"}
    </span>
  );
}

function Asset({ coin }: { coin: string }) {
  return (
    <span className="inline-flex items-center gap-2 align-middle font-semibold">
      <CoinIcon coin={coin} size={18} />
      {coinLabel(coin)}
    </span>
  );
}

function EntryPrice({ trade }: { trade: RoundTrip }) {
  const { t } = useI18n();
  if (!trade.entryApprox) return <>{price(trade.entryPx)}</>;
  return <span title={t("trader.entryApproxHint")}>≈{price(trade.entryPx)}</span>;
}

function Duration({ trade }: { trade: RoundTrip }) {
  if (trade.status === "open") return <>-</>;
  return <>{trade.partial ? `>${duration(trade.holdSeconds)}` : duration(trade.holdSeconds)}</>;
}

/** Copies a one-line summary of the trade and the page link (CopyDog opens
 * an image card; Orbie has no share images yet). */
function ShareButton({ trade }: { trade: RoundTrip }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const share = () => {
    void copyTrade(trade).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    });
  };
  return (
    <button
      type="button"
      onClick={share}
      aria-label={done ? t("trader.shareCopied") : t("trader.shareTrade")}
      title={done ? t("trader.shareCopied") : t("trader.shareTrade")}
      className="ml-1.5 inline-flex size-5 items-center justify-center rounded text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {done ? <Check className="size-3 text-positive" /> : <Share2 className="size-3" />}
    </button>
  );
}

/** The card's PnL block; on the 交易 tab it is the share button, as on
 * CopyDog's mobile cards. */
function TrailShare({ trade, enabled, children }: { trade: RoundTrip; enabled: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const className = "flex flex-col items-end gap-1";
  if (!enabled) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      className={cn(className, "rounded outline-none focus-visible:ring-2 focus-visible:ring-ring")}
      aria-label={done ? t("trader.shareCopied") : t("trader.shareTrade")}
      onClick={() => void copyTrade(trade).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); })}
    >
      {children}
      {done ? <Check className="size-3 text-positive" /> : null}
    </button>
  );
}

function copyTrade(trade: RoundTrip): Promise<void> {
  const line = `${coinLabel(trade.coin)} ${trade.side === "long" ? "Long" : "Short"} ${price(trade.entryPx)} → ${trade.exitPx === null ? "-" : price(trade.exitPx)} ${signedUsd2(shownPnl(trade))}`;
  return navigator.clipboard?.writeText(`${line}\n${window.location.href}`) ?? Promise.resolve();
}

/** A trade as CopyDog's mobile card: coin + side, entry → exit, "2d ago",
 * PnL and return. */
function TradeCard({ trade, share = false }: { trade: RoundTrip; share?: boolean }) {
  const pnl = shownPnl(trade);
  const roi = tradeReturnPct(trade);
  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
      <CoinIcon coin={trade.coin} size={26} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          {coinLabel(trade.coin)}
          <SideBadge side={trade.side} mobile />
        </span>
        <span className="num flex items-center gap-1 text-xs text-muted-foreground">
          <EntryPrice trade={trade} />
          <ArrowRight className="size-3" aria-hidden />
          {trade.exitPx === null ? "—" : price(trade.exitPx)}
        </span>
        {trade.exitTime ? <span className="num text-xs text-subtle-foreground">{ago(trade.exitTime)}</span> : null}
      </div>
      <TrailShare trade={trade} enabled={share}>
        <span className={cn("num text-sm font-semibold", pnlTone(pnl))}>{signedUsdShort(pnl)}</span>
        {roi !== null ? (
          <span className={cn("num inline-flex items-center gap-0.5 rounded px-1 text-[11px]", roi >= 0 ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
            {roi >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDown className="size-3" />}
            {Math.abs(roi).toFixed(1)}%
          </span>
        ) : null}
      </TrailShare>
    </li>
  );
}

// --- 表現 ------------------------------------------------------------------------

export type PerfView = "best" | "worst" | "asset";

/** 最佳 / 最差 / 最常交易 switch, shown in the tab bar like CopyDog's. */
export function PerfSwitch({ value, onChange }: { value: PerfView; onChange: (v: PerfView) => void }) {
  const { t } = useI18n();
  const options: Array<[PerfView, string]> = [
    ["best", t("trader.perf.best")],
    ["worst", t("trader.perf.worst")],
    ["asset", t("trader.perf.mostTraded")],
  ];
  return (
    <div role="radiogroup" aria-label={t("trader.tabs.performance")} className="flex shrink-0 items-center gap-2.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "rounded text-xs font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === v ? "text-primary" : "text-subtle-foreground hover:text-muted-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const TRADE_KEYS = {
  asset: (t: RoundTrip) => t.coin,
  side: (t: RoundTrip) => t.side,
  entry: (t: RoundTrip) => t.entryPx,
  exit: (t: RoundTrip) => t.exitPx ?? 0,
  duration: (t: RoundTrip) => t.holdSeconds,
  date: (t: RoundTrip) => new Date(t.exitTime ?? t.entryTime).getTime(),
  pnl: shownPnl,
};
type TradeKey = keyof typeof TRADE_KEYS;

/** Best or worst trades: 資產 / 買賣 / 進場價 / 出場價 / 持續時間 / 日期 / 損益. */
function TradeTable({ rows, dir }: { rows: RoundTrip[]; dir: Dir }) {
  const { t } = useI18n();
  const { sorted, sort, onSort } = useSorted<RoundTrip, TradeKey>(rows, TRADE_KEYS, { key: "pnl", dir });
  const head = { sort, onSort };
  return (
    <>
      <ul className="sm:hidden">
        {sorted.map((trade) => (
          <TradeCard key={trade.id} trade={trade} />
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortHead label={t("trader.tradeCols.asset")} col="asset" {...head} />
              <SortHead label={t("trader.tradeCols.side")} col="side" className="text-right" {...head} />
              <SortHead label={t("trader.tradeCols.entry")} col="entry" className="text-right" {...head} />
              <SortHead label={t("trader.tradeCols.exit")} col="exit" className="text-right" {...head} />
              <SortHead label={t("trader.tradeCols.duration")} col="duration" className="text-right" {...head} />
              <SortHead label={t("trader.tradeCols.date")} col="date" className="text-right" {...head} />
              <SortHead label={t("trader.tradeCols.pnl")} col="pnl" className="text-right" {...head} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((trade) => (
              <TableRow key={trade.id}>
                <TableCell>
                  <Asset coin={trade.coin} />
                </TableCell>
                <TableCell className="text-right">
                  <SideBadge side={trade.side} />
                </TableCell>
                <TableCell className="text-right">
                  <EntryPrice trade={trade} />
                </TableCell>
                <TableCell className="text-right">{trade.exitPx === null ? "—" : price(trade.exitPx)}</TableCell>
                <TableCell className="text-right">
                  <Duration trade={trade} />
                </TableCell>
                <TableCell className="text-right">{shortTime(trade.exitTime ?? trade.entryTime)}</TableCell>
                <TableCell className={cn("text-right font-semibold", pnlTone(shownPnl(trade)))}>{signedUsd2(shownPnl(trade))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/** Wins / losses as a split bar with counts (CopyDog's W/L cell). */
function WinLoss({ wins, losses }: { wins: number; losses: number }) {
  const { t } = useI18n();
  const share = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
  return (
    <div className="ml-auto flex w-28 flex-col gap-1">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-border">
        <span className="h-full bg-positive" style={{ width: `${share}%` }} />
        <span className="h-full bg-negative" style={{ width: `${100 - share}%` }} />
      </div>
      <div className="num flex justify-between text-[11px] text-muted-foreground">
        <span>
          <span className="mr-1 inline-block size-1.5 rounded-full bg-positive" />
          {t("trader.win")} {wins}
        </span>
        <span>
          <span className="mr-1 inline-block size-1.5 rounded-full bg-negative" />
          {t("trader.loss")} {losses}
        </span>
      </div>
    </div>
  );
}

const COIN_KEYS = {
  asset: (c: TradeCoin) => c.coin,
  trades: (c: TradeCoin) => c.wins + c.losses,
  winRate: (c: TradeCoin) => c.winRate,
  volume: (c: TradeCoin) => c.volume,
  pnl: (c: TradeCoin) => c.netPnl,
};
type CoinKey = keyof typeof COIN_KEYS;

/** Per asset: 資產 / 交易數 (W/L) / 勝率 / 交易量 / 損益. */
function CoinTable({ rows }: { rows: TradeCoin[] }) {
  const { t } = useI18n();
  const { sorted, sort, onSort } = useSorted<TradeCoin, CoinKey>(rows, COIN_KEYS, { key: "pnl", dir: "desc" });
  const head = { sort, onSort };
  return (
    <>
      <ul className="sm:hidden">
        {sorted.map((c) => (
          <li key={c.coin} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
            <CoinIcon coin={c.coin} size={26} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-semibold">{coinLabel(c.coin)}</span>
              <span className="num text-xs text-muted-foreground">{t("trader.nTrades", { count: c.trades })}</span>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className={cn("num text-sm font-semibold", pnlTone(c.netPnl))}>{signedUsdShort(c.netPnl)}</span>
              <span className="num text-xs text-muted-foreground">{usd2(c.volume)}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortHead label={t("trader.tradeCols.asset")} col="asset" {...head} />
              <SortHead label={t("trader.tradeCols.trades")} col="trades" className="text-right" {...head} />
              <SortHead label={t("trader.tradeCols.winRate")} col="winRate" className="text-right" {...head} />
              <SortHead label={t("trader.tradeCols.volume")} col="volume" className="text-right" {...head} />
              <SortHead label={t("trader.tradeCols.pnl")} col="pnl" className="text-right" {...head} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((c) => {
              const tone = winRateTone(c.winRate);
              return (
                <TableRow key={c.coin}>
                  <TableCell>
                    <Asset coin={c.coin} />
                  </TableCell>
                  <TableCell className="text-right">
                    <WinLoss wins={c.wins} losses={c.losses} />
                  </TableCell>
                  <TableCell className={cn("text-right", tone && TONE_CLASS[tone])}>{pct1(c.winRate)}</TableCell>
                  <TableCell className="text-right">{usd2(c.volume)}</TableCell>
                  <TableCell className={cn("text-right font-semibold", pnlTone(c.netPnl))}>{signedUsd2(c.netPnl)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/** 表現: best / worst closed trades (net PnL incl. funding, 10 each) and the
 * per-asset table, all-time as on CopyDog. */
export function PerformanceTab({
  analytics,
  computing,
  error,
  onRetry,
  view,
}: {
  analytics: TraderAnalyticsResponse | undefined;
  computing: boolean;
  error: Error | null;
  onRetry: () => void;
  view: PerfView;
}) {
  const { t } = useI18n();
  if (!analytics) {
    if (computing) return <Computing />;
    if (error) return <LoadError onRetry={onRetry} />;
    return <Loading />;
  }
  const { summary } = analytics;
  const { best, worst } = summary;
  if (best.length === 0 && summary.coins.length === 0) {
    return <Empty title={t("trader.perfEmptyTitle")} body={t("trader.perfEmptyDesc")} />;
  }
  return (
    <div>
      <CoverageNote analytics={analytics} className="px-4 pt-2 sm:px-5" />
      {view === "best" ? <TradeTable rows={best} dir="desc" /> : null}
      {view === "worst" ? <TradeTable rows={worst} dir="asc" /> : null}
      {view === "asset" ? <CoinTable rows={summary.coins} /> : null}
    </div>
  );
}

// --- 交易 ------------------------------------------------------------------------

const LEDGER_KEYS = {
  asset: (t: RoundTrip) => t.coin,
  side: (t: RoundTrip) => t.side,
  entry: (t: RoundTrip) => new Date(t.entryTime).getTime(),
  exit: (t: RoundTrip) => new Date(t.exitTime ?? t.entryTime).getTime(),
  notional: (t: RoundTrip) => t.notional,
  duration: (t: RoundTrip) => (t.status === "open" ? 0 : t.holdSeconds),
  funding: (t: RoundTrip) => t.funding ?? 0,
  netPnl: shownPnl,
};
type LedgerKey = keyof typeof LEDGER_KEYS;

/** 交易: the round-trip ledger, closed trades latest exit first as on
 * CopyDog (全部 / 持倉中 add open ones), 50 at a time. Net PnL includes
 * funding, as CopyDog shows it. */
export function TradesTab({ address }: { address: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<TradeStatusFilter>("closed");
  const query = useTraderTrades(address, status);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const first: TraderTradesResponse | undefined = query.data?.pages[0];
  const { sorted, sort, onSort } = useSorted<RoundTrip, LedgerKey>(rows, LEDGER_KEYS, { key: "exit", dir: "desc" });
  const head = { sort, onSort };
  const filterLabel = { all: t("trader.tradeFilters.all"), closed: t("trader.tradeFilters.closed"), open: t("trader.tradeFilters.open") };

  let body: React.ReactNode;
  if (query.isError) body = <LoadError onRetry={() => query.refetch()} />;
  else if (!first) body = isComputing(query) && query.failureReason ? <Computing /> : <Loading />;
  else if (rows.length === 0) {
    const dense = status === "closed" && first.coverage.truncated && first.coverage.from !== null;
    body =
      status !== "closed" ? (
        <Empty title={t("trader.filterEmpty", { filter: filterLabel[status] })} />
      ) : dense ? (
        <Empty title={t("trader.denseTitle")} body={t("trader.denseDesc", { since: shortTime(first.coverage.from) })} />
      ) : (
        <Empty title={t("trader.tradesEmptyTitle")} body={t("trader.tradesEmptyDesc")} />
      );
  } else {
    body = (
      <>
        <ul className="sm:hidden">
          {sorted.map((trade) => (
            <TradeCard key={trade.id} trade={trade} share />
          ))}
        </ul>
        <div className="hidden sm:block">
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHead label={t("trader.tradeCols.asset")} col="asset" {...head} />
                <SortHead label={t("trader.tradeCols.side")} col="side" className="text-right" {...head} />
                <SortHead label={t("trader.tradeCols.entry")} col="entry" className="text-right" {...head} />
                <SortHead label={t("trader.tradeCols.exit")} col="exit" className="text-right" {...head} />
                <SortHead label={t("trader.tradeCols.notional")} col="notional" className="text-right" {...head} />
                <SortHead label={t("trader.tradeCols.duration")} col="duration" className="text-right" {...head} />
                <SortHead label={t("trader.tradeCols.funding")} col="funding" className="text-right" {...head} />
                <SortHead label={t("trader.tradeCols.netPnl")} col="netPnl" className="text-right" {...head} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((trade) => {
                const pnl = shownPnl(trade);
                return (
                  <TableRow key={trade.id} data-status={trade.status}>
                    <TableCell>
                      <Asset coin={trade.coin} />
                    </TableCell>
                    <TableCell className="text-right">
                      <SideBadge side={trade.side} />
                    </TableCell>
                    <TableCell className="text-right">
                      <EntryPrice trade={trade} />
                      <div className="text-[11px] text-subtle-foreground" title={trade.partial ? t("trader.partialHint") : undefined}>
                        {trade.partial ? t("trader.partialBefore", { time: shortTime(trade.entryTime) }) : shortTime(trade.entryTime)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {trade.exitPx === null ? "—" : price(trade.exitPx)}
                      <div className="text-[11px] text-subtle-foreground">
                        {trade.exitTime ? (
                          shortTime(trade.exitTime)
                        ) : (
                          <span className="rounded bg-primary-soft px-1 text-primary">{t("trader.openBadge")}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{usd2(trade.notional)}</TableCell>
                    <TableCell className="text-right">
                      <Duration trade={trade} />
                    </TableCell>
                    <TableCell
                      className={cn("text-right", pnlTone(trade.funding ?? 0))}
                      title={trade.funding === null ? t("trader.fundingUnknown") : undefined}
                    >
                      {trade.funding === null ? <span className="text-subtle-foreground">—</span> : signedUsd2(trade.funding)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <span className={cn("font-semibold", pnlTone(pnl))}>{signedUsd2(pnl)}</span>
                      <ShareButton trade={trade} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {query.hasNextPage ? (
          <button
            type="button"
            disabled={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
            className="block w-full border-t border-border py-3 text-center text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {t("trader.showMore", { shown: rows.length, total: first.total })}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 sm:px-5">
        <Segmented
          value={status}
          onChange={setStatus}
          variant="pill"
          label={t("trader.tabs.trades")}
          options={[
            { value: "all", label: filterLabel.all },
            { value: "closed", label: filterLabel.closed },
            { value: "open", label: filterLabel.open },
          ]}
        />
        {first ? <CoverageNote analytics={first} /> : null}
      </div>
      {body}
    </div>
  );
}

