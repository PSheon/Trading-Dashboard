"use client";

import type { RoundTrip, TradeCoin, TraderAnalyticsResponse, TraderTradesResponse } from "@/lib/contracts";
import { OrbitSpinner } from "@/components/ui/orbit-spinner";
import { ArrowDown, ArrowRight, ArrowUpRight, Share2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { TableSkeleton } from "@/components/ui/table-skeleton";
import { TradeShareDialog, traderCardSource, type TradeCardSource } from "./trade-share-dialog";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { coinLabel, signedUsd2, signedUsdShort, timeAgo, usd2 } from "@/lib/format";
import { isComputing, isUnavailable, useTraderTrades } from "@/lib/queries";
import { useNow } from "@/lib/use-now";
import {
  duration,
  pct1,
  pnlTone,
  price,
  shortTime,
  tradeReturnPct,
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

/** A tab's table while it loads: its real header over raised rows of
 * bars (TableSkeleton). `cols`: the header labels; the first `left` sit
 * left, the rest right, as in the loaded table. */
function TabTableSkeleton({ cols, left = 1 }: { cols: string[]; left?: number }) {
  return <TableSkeleton dense tableClassName="text-xs" rows={6} columns={cols.map((label, i) => ({ label, right: i >= left }))} />;
}

function Computing({ cols, left }: { cols: string[]; left?: number }) {
  const { t } = useI18n();
  return (
    <div role="status">
      <p className="pt-2 text-center text-xs text-muted-foreground">{t("trader.computing")}</p>
      <TabTableSkeleton cols={cols} left={left} />
    </div>
  );
}

/** The best / worst trades table's and the ledger's columns. */
const TRADE_COLS = ["asset", "side", "entry", "exit", "duration", "date", "pnl"] as const;
const LEDGER_COLS = ["asset", "side", "entry", "exit", "notional", "duration", "funding", "netPnl"] as const;

export function Loading({ cols, left }: { cols: string[]; left?: number }) {
  return <TabTableSkeleton cols={cols} left={left} />;
}

export function LoadError({ onRetry, message }: { onRetry: () => void; message?: string }) {
  const { t } = useI18n();
  return (
    <p role="status" className="py-12 text-center text-sm text-muted-foreground">
      {message ?? t("trader.analyticsFailed")}{" "}
      <button type="button" className="text-primary-text underline" onClick={onRetry}>
        {t("trader.retry")}
      </button>
    </p>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {body ? <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{body}</p> : null}
    </div>
  );
}

/** "Based on trades since …" when older history isn't included. CopyDog
 * shows no such note, so the trader tabs no longer render it; it stays for
 * surfaces that need the disclosure (and its test). */
export function CoverageNote({ analytics, className }: { analytics: Pick<TraderAnalyticsResponse, "coverage">; className?: string }) {
  const { t, format } = useI18n();
  const { coverage } = analytics;
  return (
    <p className={cn("text-[11px] leading-relaxed text-subtle-foreground", className)} title={t("trader.coverageHint")}>
      {coverage.truncated && coverage.from !== null ? t("trader.coverageSince", { date: format.date(coverage.from) }) : null}{" "}
      <span className="block">{coverage.through ? t("trader.historyThrough", { date: format.dateTime(coverage.through) }) : t("trader.historyThroughUnknown")}</span>
      {coverage.backfill ? <span className="block">{t(`trader.historyStatus.${coverage.backfill.status}`)}</span> : null}
      {coverage.truncated || coverage.backfill ? <span className="block">{t("trader.historyRetention")}</span> : null}
      {coverage.fundingThrough ? t("trader.fundingThrough", { date: format.date(coverage.fundingThrough) }) : t("trader.fundingPending")}
    </p>
  );
}

// --- sortable headers ----------------------------------------------------------

export type Dir = "asc" | "desc";

export function useSorted<T, K extends string>(rows: T[], keys: Record<K, (row: T) => number | string>, initial: { key: K; dir: Dir }) {
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

export function SortHead<K extends string>({
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
        "chip-sm",
        long ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground",
      )}
    >
      {mobile ? t(long ? "trader.sideLong" : "trader.sideShort") : long ? "Long" : "Short"}
    </span>
  );
}

export function Asset({ coin }: { coin: string }) {
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

function tradeSource(address: string, trade: RoundTrip): TradeCardSource {
  return traderCardSource(address, "trade", trade.id, coinLabel(trade.coin));
}

function ShareButton({ trade, address }: { trade: RoundTrip; address: string }) {
  const { t } = useI18n();
  const [source, setSource] = useState<TradeCardSource | null>(null);
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setSource(tradeSource(address, trade))}
      aria-label={t("trader.shareTrade")} title={t("trader.shareTrade")}
      className="ml-1.5 inline-flex size-5 items-center justify-center rounded text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <Share2 className="size-3" />
    </button>
    {source ? <TradeShareDialog source={source} onClose={() => setSource(null)} /> : null}
  </>;
}

function TrailShare({ trade, address, children }: { trade: RoundTrip; address: string | null; children: React.ReactNode }) {
  const { t } = useI18n();
  const [source, setSource] = useState<TradeCardSource | null>(null);
  const className = "flex shrink-0 flex-col items-end gap-1 pl-2";
  if (!address) return <div className={className}>{children}</div>;
  return <>
    <button type="button" className={cn(className, "rounded outline-none focus-visible:ring-2 focus-visible:ring-ring")}
      aria-haspopup="dialog" aria-label={t("trader.shareTrade")}
      onClick={() => setSource(tradeSource(address, trade))}>{children}</button>
    {source ? <TradeShareDialog source={source} onClose={() => setSource(null)} /> : null}
  </>;
}

/** A trade as CopyDog's mobile card: coin + side, entry → exit, "2d ago",
 * PnL and return. */
export function TradeCard({ trade, shareAddress = null }: { trade: RoundTrip; /** The trader's address: the card opens the share dialog. */ shareAddress?: string | null }) {
  const { locale } = useI18n(), now = useNow();
  const pnl = shownPnl(trade);
  const roi = tradeReturnPct(trade);
  return (
    <li className="flex items-start gap-3 border-b-2 border-dotted border-border px-4 py-3 last:border-0">
      <span className="mt-px shrink-0"><CoinIcon coin={trade.coin} size={26} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-1.5 text-[15px] leading-[23px] font-semibold">
          {coinLabel(trade.coin)}
          <SideBadge side={trade.side} mobile />
        </span>
        <span className="num flex min-w-0 items-center gap-1 text-xs leading-[18px] text-muted-foreground">
          <EntryPrice trade={trade} />
          <ArrowRight className="size-3 shrink-0" aria-hidden />
          {trade.exitPx === null ? "—" : price(trade.exitPx)}
        </span>
        {trade.exitTime ? <span className="num text-xs leading-[18px] text-muted-foreground">{timeAgo(trade.exitTime, now, locale)}</span> : null}
      </div>
      <TrailShare trade={trade} address={shareAddress}>
        <span className={cn("num text-[15px] leading-[23px] font-semibold", pnlTone(pnl))}>{signedUsdShort(pnl)}</span>
        {roi !== null ? (
          <span className={cn("num chip-sm", roi >= 0 ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>
            {roi >= 0 ? <ArrowUpRight className="size-[9px]" strokeWidth={2.5} /> : <ArrowDown className="size-[9px]" strokeWidth={2.5} />}
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
    <div role="radiogroup" aria-label={t("trader.tabs.performance")} className="mr-2.5 hidden shrink-0 items-center gap-3 sm:flex">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "rounded font-mono text-[11px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            value === v ? "text-primary-text" : "text-muted-foreground hover:text-foreground",
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
      <ul className="overflow-hidden rounded-2xl bg-card sm:hidden">
        {sorted.filter((trade) => (dir === "desc" ? shownPnl(trade) > 0 : shownPnl(trade) < 0)).map((trade) => (
          <TradeCard key={trade.id} trade={trade} />
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table dense className="text-xs">
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
                <TableCell className={cn("text-right", pnlTone(shownPnl(trade)))}>{signedUsd2(shownPnl(trade))}</TableCell>
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
      <ul className="overflow-hidden rounded-2xl bg-card sm:hidden">
        {sorted.map((c) => (
          <li key={c.coin} className="flex items-center gap-3 border-b-2 border-dotted border-border px-4 py-3 last:border-0">
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
        <Table dense className="text-xs">
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
                  <TableCell className={cn("text-right", pnlTone(c.netPnl))}>{signedUsd2(c.netPnl)}</TableCell>
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
  unavailable = false,
  error,
  onRetry,
  view,
  onView,
}: {
  analytics: TraderAnalyticsResponse | undefined;
  computing: boolean;
  /** The api stayed busy past the page's patience: 暫時無法取得 and 重試. */
  unavailable?: boolean;
  error: Error | null;
  onRetry: () => void;
  view: PerfView;
  onView: (view: PerfView) => void;
}) {
  const { t } = useI18n();
  if (!analytics) {
    const cols = TRADE_COLS.map((k) => t(`trader.tradeCols.${k}`));
    if (computing) return <Computing cols={cols} />;
    if (unavailable) return <LoadError onRetry={onRetry} message={t("trader.analyticsUnavailable")} />;
    if (error) return <LoadError onRetry={onRetry} />;
    return <Loading cols={cols} />;
  }
  const { summary } = analytics;
  const { best, worst } = summary;
  if (best.length === 0 && summary.coins.length === 0) {
    return <Empty title={t("trader.perfEmptyTitle")} body={t("trader.perfEmptyDesc")} />;
  }
  return (
    <div>
      {/* Below sm the switch sits here, full width, as on CopyDog's app. */}
      <div role="radiogroup" aria-label={t("trader.tabs.performance")} className="mb-4 flex gap-0.5 rounded-full bg-card p-[3px] sm:hidden">
        {([
          ["best", t("trader.perf.best")],
          ["worst", t("trader.perf.worst")],
          ["asset", t("trader.perf.byAsset")],
        ] as Array<[PerfView, string]>).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={view === v}
            onClick={() => onView(v)}
            className={cn(
              "min-w-0 flex-1 rounded-full px-3 py-[9px] text-xs leading-[18px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              view === v ? "bg-raised-hover text-foreground" : "text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {/* CopyDog insets these tables 12px inside the card. */}
      <div className="sm:px-3">
        {view === "best" ? <TradeTable rows={best} dir="desc" /> : null}
        {view === "worst" ? <TradeTable rows={worst} dir="asc" /> : null}
        {view === "asset" ? <CoinTable rows={summary.coins} /> : null}
      </div>
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

/** 交易: the round-trip ledger, closed trades only, latest exit first, 50
 * at a time, as on CopyDog (its live page has no status filter). Net PnL
 * includes funding, as CopyDog shows it. */
export function TradesTab({ address }: { address: string }) {
  const { t } = useI18n();
  const query = useTraderTrades(address, "closed");
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const first: TraderTradesResponse | undefined = query.data?.pages[0];
  const { sorted, sort, onSort } = useSorted<RoundTrip, LedgerKey>(rows, LEDGER_KEYS, { key: "exit", dir: "desc" });
  const head = { sort, onSort };

  let body: React.ReactNode;
  // A failed "show more" or background refresh keeps the pages already loaded.
  if (query.isError && !first) body = <LoadError onRetry={() => query.refetch()} />;
  else if (!first) {
    const cols = LEDGER_COLS.map((k) => t(`trader.tradeCols.${k}`));
    body = isComputing(query) && query.failureReason ? <Computing cols={cols} />
      : isUnavailable(query) ? <LoadError onRetry={() => query.refetch()} message={t("trader.analyticsUnavailable")} /> : <Loading cols={cols} />;
  }
  else if (rows.length === 0) {
    const dense = first.coverage.truncated && first.coverage.from !== null;
    body =
      dense ? (
        <Empty title={t("trader.denseTitle")} body={t("trader.denseDesc", { since: shortTime(first.coverage.from) })} />
      ) : (
        <Empty title={t("trader.tradesEmptyTitle")} body={t("trader.tradesEmptyDesc")} />
      );
  } else {
    body = (
      <>
        <ul className="overflow-hidden rounded-2xl bg-card sm:hidden">
          {sorted.map((trade) => (
            <TradeCard key={trade.id} trade={trade} shareAddress={address} />
          ))}
        </ul>
        <div className="hidden sm:block">
          <Table dense className="text-xs">
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
                        {trade.exitTime ? shortTime(trade.exitTime) : "—"}
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
                      <span className={pnlTone(pnl)}>{signedUsd2(pnl)}</span>
                      <ShareButton trade={trade} address={address} />
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
            aria-busy={query.isFetchingNextPage || undefined}
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            className="flex w-full items-center justify-center gap-1.5 border-t-2 border-dotted border-border py-3 text-center text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {query.isFetchingNextPage ? <OrbitSpinner className="size-3.5" /> : null}
            {t("trader.showMore", { shown: rows.length, total: first.total })}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <div>
      {body}
      {/* Orbie's disclosure of the history and funding read; CopyDog has
          none, so it sits under the table rather than above it. */}
    </div>
  );
}

