"use client";

import type {
  LivePosition,
  SpotBalance,
  TraderFill,
  TraderOrder,
  TraderProfileResponse,
  TraderTransfer,
  TraderTwap,
} from "@/lib/contracts";
import { ArrowDownRight, ArrowUpRight, Share2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { CoinIcon } from "@/components/traders/coin-icon";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { coinLabel } from "@/lib/format";
import { useTraderOrders, useTraderTransfers, useTraderTwap } from "@/lib/queries";
import {
  duration,
  liqDistance,
  pnlTone,
  price,
  qty,
  shortHex,
  shortTime,
  signedPct2,
  signedUsd2,
  signedUsdShort,
  usd2,
  usdFull,
} from "@/lib/trade-format";
import { Asset, Empty, LoadError, Loading, SortHead, useSorted } from "./trade-analytics";
import { TradeShareDialog, traderCardSource, type TradeCardSource } from "./trade-share-dialog";

/**
 * CopyDog's trader-page tabs beyond the trade analytics: 持倉, 餘額, 訂單,
 * 成交, TWAP and 轉帳, with its columns, default sorts, formats and empty
 * states (its bundle's "hyperdash" tables, read 2026-09-30), in Orbie's
 * palette. Tables are CopyDog-dense and scroll inside their card.
 */

const BUY_BADGE = "bg-tag-profit text-tag-profit-foreground";
const SELL_BADGE = "bg-tag-loss text-tag-loss-foreground";

function Badge({ tone, children }: { tone: "buy" | "sell" | "move"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-[6px] px-[7px] py-0.5 text-xs font-semibold whitespace-nowrap",
        tone === "buy" ? BUY_BADGE : tone === "sell" ? SELL_BADGE : "bg-raised text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

// --- 持倉 -------------------------------------------------------------------------

/** Live mid when the socket has one, else the mark implied by the REST
 * position value. */
export function markOf(p: LivePosition, marks: Readonly<Record<string, number>>): number | null {
  return marks[p.coin] ?? (p.szi !== 0 ? p.positionValue / Math.abs(p.szi) : null);
}

/** Unrealized PnL as a % of the entry notional, as CopyDog shows it (e.g.
 * −$700K on 310K DRAM entered at $63.07 → −3.6%); Hyperliquid's return on
 * margin when there is no entry price. */
const pnlPct = (p: LivePosition) => {
  const entryNotional = p.entryPx === null ? 0 : Math.abs(p.szi) * p.entryPx;
  if (entryNotional > 0) return (p.unrealizedPnl / entryNotional) * 100;
  return p.returnOnEquity == null ? null : p.returnOnEquity * 100;
};
/** Funding received since open: CopyDog shows −cumFunding.sinceOpen. */
const fundingOf = (p: LivePosition) => (p.fundingSinceOpen == null ? null : -p.fundingSinceOpen);

const LIQ_TONE = {
  critical: "bg-negative text-background",
  danger: "bg-tag-loss text-tag-loss-foreground",
  warn: "bg-tag-warning text-tag-warning-foreground",
  safe: "bg-raised text-muted-foreground",
} as const;

/** 強平價 with its distance-to-liquidation pill. */
function LiqCell({ p, mark }: { p: LivePosition; mark: number | null }) {
  const { t } = useI18n();
  const d = liqDistance(p.liqPx, mark);
  if (!d || p.liqPx === null) return <span className="text-subtle-foreground">—</span>;
  const label = d.pct >= 100 ? ">100%" : `${d.pct.toFixed(d.pct < 10 ? 2 : 1)}%`;
  return (
    <span className="inline-flex items-center gap-[7px] leading-tight" title={t("trader.liqTip", { pct: d.pct >= 100 ? ">100" : d.pct.toFixed(2) })}>
      {price(p.liqPx)}
      <span className={cn("rounded-[6px] px-[7px] py-0.5 text-xs font-semibold", LIQ_TONE[d.tone])}>{label}</span>
    </span>
  );
}

/** Leverage in the side's colour (green long, red short); the side is also
 * in its title and for screen readers. */
function LeverageChip({ p }: { p: LivePosition }) {
  const { t } = useI18n();
  if (!p.leverage) return null;
  const side = t(p.side === "long" ? "trader.sideLong" : "trader.sideShort");
  return (
    <span title={side} className={cn("inline-flex items-center rounded-[6px] px-1 py-px text-xs leading-[18px] font-bold", p.side === "long" ? BUY_BADGE : SELL_BADGE)}>
      {Math.round(p.leverage)}×<span className="sr-only"> {side}</span>
    </span>
  );
}

function SharePosition({ p, onShare }: { p: LivePosition; mark: number | null; onShare: (coin: string) => void }) {
  const { t } = useI18n();
  return <>
    <button type="button" aria-haspopup="dialog"
      onClick={() => onShare(p.coin)}
      aria-label={t("trader.sharePosition")} title={t("trader.sharePosition")}
      className="ml-2 inline-flex size-5 items-center justify-center rounded-md align-middle text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <Share2 className="size-3" />
    </button>
  </>;
}

/** CopyDog's mobile position card: coin, side, leverage, size; PnL and its
 * % pill; value / entry / mark / liquidation underneath. */
function PositionCard({ p, mark, onShare }: { p: LivePosition; mark: number | null; onShare: (coin: string) => void }) {
  const { t } = useI18n();
  const pct = pnlPct(p);
  return (
    <li className="orbit-card flex flex-col gap-3 rounded-[24px]! p-4">
      <div className="flex items-start gap-2">
        <CoinIcon coin={p.coin} size={30} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5 text-base leading-6 font-semibold">
            {coinLabel(p.coin)}
            <span className={cn("rounded-[6px] px-[7px] py-0.5 text-xs font-semibold", p.side === "long" ? BUY_BADGE : SELL_BADGE)}>
              {t(p.side === "long" ? "trader.sideLong" : "trader.sideShort")}
            </span>
            <LeverageChip p={p} />
          </span>
          <span className="num text-xs leading-[18px] text-muted-foreground">
            {qty(Math.abs(p.szi))} {coinLabel(p.coin)}
          </span>
        </div>
        <div className="flex flex-col items-end gap-[3px]">
          <span className={cn("num text-base leading-[23px] font-semibold", pnlTone(p.unrealizedPnl))}>{signedUsdShort(p.unrealizedPnl)}<SharePosition p={p} mark={mark} onShare={onShare} /></span>
          {pct !== null ? (
            <span className={cn("num inline-flex items-center rounded-[6px] p-1 text-xs font-semibold", pct >= 0 ? BUY_BADGE : SELL_BADGE)}>
              {pct >= 0 ? <ArrowUpRight className="size-[9px]" strokeWidth={2.5} /> : <ArrowDownRight className="size-[9px]" strokeWidth={2.5} />}
              {Math.abs(pct).toFixed(1)}%
            </span>
          ) : null}
        </div>
      </div>
      <dl className="num grid grid-cols-4 gap-2 border-t-2 border-dotted border-border pt-3">
        {[
          [t("trader.cols.value"), usd2(p.positionValue), ""],
          [t("trader.cols.entry"), price(p.entryPx), ""],
          [t("trader.cols.mark"), price(mark), ""],
          [t("trader.cols.liqFlag"), p.liqPx === null ? "—" : price(p.liqPx), p.liqPx === null ? "" : "text-negative"],
        ].map(([label, value, tone]) => (
          <div key={label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-[10px] font-semibold text-muted-foreground">{label}</dt>
            <dd className={cn("truncate text-[13px] leading-5 font-semibold", tone)}>{value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

type PositionKey = "asset" | "size" | "value" | "entry" | "mark" | "pnl" | "liquidation" | "margin" | "funding";

/** 持倉: 資產 (the leverage chip's colour is the side: CopyDog hides its
 * Long / Short badge in this table) / 數量 / 價值 / 進場價 / 標記價 / 損益 (%) /
 * 強平價 (distance) / 保證金 / 資金費, largest value first; cards on phones. */
export function PositionsTab({ profile, marks }: { profile: TraderProfileResponse; marks: Readonly<Record<string, number>> }) {
  const { t } = useI18n();
  const [source, setSource] = useState<TradeCardSource | null>(null);
  const share = source ? <TradeShareDialog source={source} onClose={() => setSource(null)} /> : null;
  const setSnapshot = (coin: string) => setSource(traderCardSource(profile.address, "position", coin, coinLabel(coin)));
  const keys = useMemo<Record<PositionKey, (p: LivePosition) => number | string>>(
    () => ({
      asset: (p) => p.coin,
      size: (p) => Math.abs(p.szi),
      value: (p) => p.positionValue,
      entry: (p) => p.entryPx ?? 0,
      mark: (p) => markOf(p, marks) ?? 0,
      pnl: (p) => p.unrealizedPnl,
      liquidation: (p) => liqDistance(p.liqPx, markOf(p, marks))?.pct ?? Number.MAX_VALUE,
      margin: (p) => p.marginUsed ?? 0,
      funding: (p) => fundingOf(p) ?? 0,
    }),
    [marks],
  );
  const { sorted, sort, onSort } = useSorted<LivePosition, PositionKey>(profile.positions, keys, { key: "value", dir: "desc" });
  if (profile.positions.length === 0) {
    return <><Empty title={t(profile.perpEquity === null ? "trader.positionsUnavailable" : "trader.noPositions")} />{share}</>;
  }
  const head = { sort, onSort };
  return (
    <>
      {share}
      <ul className="flex flex-col gap-3 sm:hidden">
        {sorted.map((p) => (
          <PositionCard key={p.coin} p={p} mark={markOf(p, marks)} onShare={setSnapshot} />
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table dense className="text-xs">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortHead label={t("trader.cols.coin")} col="asset" {...head} />
              <SortHead label={t("trader.cols.size")} col="size" className="text-right" {...head} />
              <SortHead label={t("trader.cols.value")} col="value" className="text-right" {...head} />
              <SortHead label={t("trader.cols.entry")} col="entry" className="text-right" {...head} />
              <SortHead label={t("trader.cols.mark")} col="mark" className="text-right" {...head} />
              <SortHead label={t("trader.cols.pnl")} col="pnl" className="text-right" {...head} />
              <SortHead label={t("trader.cols.liq")} col="liquidation" className="text-right" {...head} />
              <SortHead label={t("trader.cols.margin")} col="margin" className="text-right" {...head} />
              <SortHead label={t("trader.cols.funding")} col="funding" className="text-right" {...head} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((p) => {
              const mark = markOf(p, marks);
              const pct = pnlPct(p);
              const funding = fundingOf(p);
              return (
                <TableRow key={p.coin}>
                  <TableCell>
                    <span className="inline-flex items-center gap-2 align-middle font-semibold">
                      <CoinIcon coin={p.coin} size={18} />
                      {coinLabel(p.coin)}
                      <LeverageChip p={p} />
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{qty(Math.abs(p.szi))}</TableCell>
                  <TableCell className="text-right">{usd2(p.positionValue)}</TableCell>
                  <TableCell className="text-right">{price(p.entryPx)}</TableCell>
                  <TableCell className="text-right" data-testid="mark">{price(mark)}</TableCell>
                  <TableCell className={cn("text-right whitespace-nowrap", pnlTone(p.unrealizedPnl))}>
                    {signedUsd2(p.unrealizedPnl)}
                    {pct !== null ? <span> ({signedPct2(pct)})</span> : null}
                    <SharePosition p={p} mark={mark} onShare={setSnapshot} />
                  </TableCell>
                  <TableCell className="text-right">
                    <LiqCell p={p} mark={mark} />
                  </TableCell>
                  <TableCell className="text-right">{p.marginUsed == null ? "—" : usd2(p.marginUsed)}</TableCell>
                  <TableCell className={cn("text-right", funding === null ? "text-subtle-foreground" : pnlTone(funding))}>
                    {funding === null ? "—" : signedUsd2(funding)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

// --- 餘額 -------------------------------------------------------------------------

type BalanceKey = "asset" | "amount" | "available" | "value";
const BALANCE_KEYS: Record<BalanceKey, (b: SpotBalance) => number | string> = {
  asset: (b) => b.coin,
  amount: (b) => b.total,
  available: (b) => b.total - (b.hold ?? 0),
  value: (b) => (b.px === null ? -1 : b.value),
};

/** 餘額: spot balances, 資產 / 數量 / 可用 / 價值, valued with the same marks
 * as the account value (live mids when close to them). */
export function BalancesTab({ balances }: { balances: SpotBalance[] }) {
  const { t } = useI18n();
  const { sorted, sort, onSort } = useSorted<SpotBalance, BalanceKey>(balances, BALANCE_KEYS, { key: "value", dir: "desc" });
  if (balances.length === 0) return <Empty title={t("trader.empty.balancesTitle")} body={t("trader.empty.balancesDesc")} />;
  const head = { sort, onSort };
  return (
    <Table dense className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortHead label={t("trader.cols.coin")} col="asset" {...head} />
          <SortHead label={t("trader.cols.amount")} col="amount" className="text-right" {...head} />
          <SortHead label={t("trader.cols.available")} col="available" className="text-right" {...head} />
          <SortHead label={t("trader.cols.value")} col="value" className="text-right" {...head} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((b) => (
          <TableRow key={b.coin}>
            <TableCell>
              <span className="inline-flex items-center gap-2 align-middle font-semibold">
                <CoinIcon coin={b.coin} size={18} />
                {b.coin}
              </span>
            </TableCell>
            <TableCell className="text-right">{qty(b.total)}</TableCell>
            <TableCell className="text-right">{qty(b.total - (b.hold ?? 0))}</TableCell>
            <TableCell className="text-right">{b.px === null ? "—" : usd2(b.value)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- 訂單 -------------------------------------------------------------------------

/** CopyDog's order side: a buy opens a long unless reduce-only (then it
 * closes a short), a sell the reverse. */
function orderSide(o: TraderOrder): "long" | "short" | "closeLong" | "closeShort" {
  if (o.side === "buy") return o.reduceOnly ? "closeShort" : "long";
  return o.reduceOnly ? "closeLong" : "short";
}

type OrderKey = "asset" | "type" | "side" | "size" | "price" | "value" | "trigger";
const ORDER_KEYS: Record<OrderKey, (o: TraderOrder) => number | string> = {
  asset: (o) => o.coin,
  type: (o) => o.orderType,
  side: (o) => orderSide(o),
  size: (o) => o.size,
  price: (o) => o.limitPx ?? 0,
  value: (o) => o.size * (o.limitPx ?? 0),
  trigger: (o) => o.triggerPx ?? 0,
};

/** 訂單: resting orders on every dex, 資產 / 類型 / 買賣 / 數量 / 價格 / 價值
 * / 觸發價, largest value first. */
export function OrdersTab({ address }: { address: string }) {
  const { t } = useI18n();
  const query = useTraderOrders(address);
  const rows = query.data?.orders ?? [];
  const { sorted, sort, onSort } = useSorted<TraderOrder, OrderKey>(rows, ORDER_KEYS, { key: "value", dir: "desc" });
  if (query.isError && !query.data) return <LoadError onRetry={() => query.refetch()} />;
  if (!query.data) return <Loading />;
  if (rows.length === 0) return <Empty title={t("trader.empty.ordersTitle")} body={t("trader.empty.ordersDesc")} />;
  const head = { sort, onSort };
  return (
    <Table dense className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortHead label={t("trader.cols.coin")} col="asset" {...head} />
          <SortHead label={t("trader.cols.type")} col="type" className="text-right" {...head} />
          <SortHead label={t("trader.cols.orderSide")} col="side" className="text-right" {...head} />
          <SortHead label={t("trader.cols.size")} col="size" className="text-right" {...head} />
          <SortHead label={t("trader.cols.price")} col="price" className="text-right" {...head} />
          <SortHead label={t("trader.cols.value")} col="value" className="text-right" {...head} />
          <SortHead label={t("trader.cols.trigger")} col="trigger" className="text-right" {...head} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((o) => {
          const side = orderSide(o);
          return (
            <TableRow key={o.oid}>
              <TableCell>
                <Asset coin={o.coin} />
              </TableCell>
              <TableCell className="text-right">{o.orderType || "-"}</TableCell>
              <TableCell className="text-right">
                <Badge tone={side === "long" || side === "closeShort" ? "buy" : "sell"}>{t(`trader.orderSides.${side}`)}</Badge>
              </TableCell>
              <TableCell className="text-right">
                {qty(o.size)} {coinLabel(o.coin)}
              </TableCell>
              <TableCell className="text-right">{o.limitPx ? price(o.limitPx) : "-"}</TableCell>
              <TableCell className="text-right">{usd2(o.size * (o.limitPx ?? 0))}</TableCell>
              <TableCell className="text-right" title={o.triggerCondition ?? undefined}>
                {o.triggerPx ? price(o.triggerPx) : "N/A"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// --- 成交 -------------------------------------------------------------------------

/** CopyDog's 成交 reads one page of Hyperliquid fills: 2,000, the most
 * `userFills` returns. A full page means older fills were cut off. */
export const FILL_LIMIT = 2000;

/** Whether a fills list hit the page limit (CopyDog's `truncated`). */
export function fillsTruncated(restFills: readonly TraderFill[] | undefined): boolean {
  return (restFills?.length ?? 0) >= FILL_LIMIT;
}

/** Consecutive fills of one order stream (same coin, side, direction and
 * liquidation flag), newest first, merged into one row as CopyDog does
 * (its bundle's grouping, 2026-10-01): summed size, value and PnL,
 * volume-weighted price, the oldest fill's starting position, and the count
 * of fills (one per timestamp, as CopyDog's aggregated fills) as a badge. `partial` marks the oldest row when the list was
 * capped, whose size and value then read "≥". */
export interface FillGroup {
  key: string;
  coin: string;
  dir: string;
  side: TraderFill["side"];
  size: number;
  value: number;
  pnl: number;
  price: number;
  count: number;
  time: number;
  liquidation: boolean;
  startPosition: number | null;
  partial?: boolean;
}

export function groupFills(fills: readonly TraderFill[], truncated = false): FillGroup[] {
  const groups: FillGroup[] = [];
  let current: FillGroup | null = null;
  let currentKey = "";
  let lastTime = Number.NaN;
  let startTime = Number.NaN;
  const sorted = [...fills].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  sorted.forEach((f, i) => {
    const key = `${f.coin}|${f.side}|${f.dir}|${f.liquidation ? 1 : 0}`;
    if (!current || key !== currentKey) {
      currentKey = key;
      lastTime = Number.NaN;
      startTime = Number.NaN;
      current = {
        key: `f${f.ts}-${f.tid}-${i}`,
        coin: f.coin,
        dir: f.dir,
        side: f.side,
        size: 0,
        value: 0,
        pnl: 0,
        price: 0,
        count: 0,
        time: new Date(f.ts).getTime(),
        liquidation: !!f.liquidation,
        startPosition: f.startPosition ?? null,
      };
      groups.push(current);
    }
    current.size += f.sz;
    current.value += f.notionalUsd;
    current.pnl += f.closedPnl ?? 0;
    // CopyDog's fills come aggregated by time (one per order per block), so
    // its badge counts those: partial fills sharing a timestamp count once.
    const at = new Date(f.ts).getTime();
    if (at !== lastTime || current.count === 0) current.count += 1;
    lastTime = at;
    // The oldest fill's starting position; among partial fills of one
    // timestamp that is the one furthest from the fill's direction (the
    // smallest position when adding, the largest when reducing).
    const start = f.startPosition ?? null;
    if (start === null || current.startPosition === null || at !== startTime) current.startPosition = start;
    else {
      const adding = (f.side === "buy") === (start >= 0);
      current.startPosition = adding
        ? (Math.abs(start) < Math.abs(current.startPosition) ? start : current.startPosition)
        : (Math.abs(start) > Math.abs(current.startPosition) ? start : current.startPosition);
    }
    startTime = at;
  });
  for (const g of groups) g.price = g.size ? g.value / g.size : 0;
  if (truncated && groups.length > 0) groups[groups.length - 1].partial = true;
  return groups;
}

/** "Long Liq" / "Short Liq" for a liquidation, else Hyperliquid's `dir`. */
function fillDirection(g: FillGroup): string {
  if (g.liquidation) return g.dir.toLowerCase().includes("short") ? "Short Liq" : "Long Liq";
  return g.dir || (g.side === "buy" ? "Buy" : "Sell");
}
function fillTone(dir: string): "buy" | "sell" {
  const d = dir.toLowerCase();
  return d === "open long" || d === "close short" || d === "buy" ? "buy" : "sell";
}

type FillKey = "asset" | "direction" | "size" | "origPos" | "price" | "value" | "pnl" | "liq" | "time";
const FILL_KEYS: Record<FillKey, (g: FillGroup) => number | string> = {
  asset: (g) => g.coin,
  direction: (g) => fillDirection(g),
  size: (g) => g.size,
  origPos: (g) => g.startPosition ?? 0,
  price: (g) => g.price,
  value: (g) => g.value,
  pnl: (g) => g.pnl,
  liq: (g) => (g.liquidation ? 1 : 0),
  time: (g) => g.time,
};

/** 成交: fills (perp and spot) grouped by order stream, 資產 (count) / 方向
 * / 數量 / 原持倉 / 價格 / 價值 / 損益 / 強平 / 時間, newest first. */
export function FillsTab({ rows, truncated = false }: { rows: TraderFill[]; truncated?: boolean }) {
  const { t } = useI18n();
  const groups = useMemo(() => groupFills(rows, truncated), [rows, truncated]);
  const { sorted, sort, onSort } = useSorted<FillGroup, FillKey>(groups, FILL_KEYS, { key: "time", dir: "desc" });
  if (rows.length === 0) return <Empty title={t("trader.empty.fillsTitle")} body={t("trader.empty.fillsDesc")} />;
  const head = { sort, onSort };
  return (
    <Table dense className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortHead label={t("trader.cols.coin")} col="asset" {...head} />
          <SortHead label={t("trader.cols.direction")} col="direction" className="text-right" {...head} />
          <SortHead label={t("trader.cols.size")} col="size" className="text-right" {...head} />
          <SortHead label={t("trader.cols.origPos")} col="origPos" className="text-right" {...head} />
          <SortHead label={t("trader.cols.price")} col="price" className="text-right" {...head} />
          <SortHead label={t("trader.cols.value")} col="value" className="text-right" {...head} />
          <SortHead label={t("trader.cols.pnl")} col="pnl" className="text-right" {...head} />
          <SortHead label={t("trader.cols.liqFlag")} col="liq" className="text-right" {...head} />
          <SortHead label={t("trader.cols.time")} col="time" className="text-right" {...head} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((g) => {
          const dir = fillDirection(g);
          return (
            <TableRow key={g.key}>
              <TableCell>
                <span className="inline-flex items-center gap-2 align-middle font-semibold">
                  <CoinIcon coin={g.coin} size={18} />
                  {coinLabel(g.coin)}
                  {g.count > 1 ? (
                    <span className="num rounded-full bg-raised px-1.5 text-[10px] font-semibold text-muted-foreground" data-testid="fill-count" title={String(g.count)}>
                      {g.count}
                    </span>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <Badge tone={fillTone(g.liquidation ? "sell" : dir)}>{dir}</Badge>
              </TableCell>
              <TableCell className="text-right">
                {g.partial ? "≥" : ""}
                {qty(g.size)} {coinLabel(g.coin)}
              </TableCell>
              <TableCell className="text-right">{g.startPosition === null ? "—" : qty(g.startPosition)}</TableCell>
              <TableCell className="text-right">{price(g.price)}</TableCell>
              <TableCell className="text-right">
                {g.partial ? "≥" : ""}
                {usd2(g.value)}
              </TableCell>
              <TableCell className={cn("text-right", pnlTone(g.pnl))}>{g.pnl ? signedUsd2(g.pnl) : "—"}</TableCell>
              <TableCell className="text-right">
                {g.liquidation ? <span className="text-negative">{t("trader.yes")}</span> : t("trader.no")}
              </TableCell>
              <TableCell className="text-right">{shortTime(g.time)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// --- TWAP -------------------------------------------------------------------------

type TwapKey = "asset" | "side" | "size" | "filled" | "duration" | "time";
const TWAP_KEYS: Record<TwapKey, (w: TraderTwap) => number | string> = {
  asset: (w) => w.coin,
  side: (w) => w.side,
  size: (w) => w.size,
  filled: (w) => w.filledFraction,
  duration: (w) => w.minutes,
  time: (w) => new Date(w.startedAt).getTime(),
};

/** TWAP: running TWAP orders, 資產 / 買賣 / 數量 / 已成交 / 持續時間 / 時間. */
export function TwapTab({ address }: { address: string }) {
  const { t } = useI18n();
  const query = useTraderTwap(address);
  const rows = query.data?.twaps ?? [];
  const { sorted, sort, onSort } = useSorted<TraderTwap, TwapKey>(rows, TWAP_KEYS, { key: "time", dir: "desc" });
  if (query.isError && !query.data) return <LoadError onRetry={() => query.refetch()} />;
  if (!query.data) return <Loading />;
  if (rows.length === 0) return <Empty title={t("trader.empty.twapTitle")} body={t("trader.empty.twapDesc")} />;
  const head = { sort, onSort };
  return (
    <Table dense className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortHead label={t("trader.cols.coin")} col="asset" {...head} />
          <SortHead label={t("trader.cols.orderSide")} col="side" className="text-right" {...head} />
          <SortHead label={t("trader.cols.size")} col="size" className="text-right" {...head} />
          <SortHead label={t("trader.cols.filled")} col="filled" className="text-right" {...head} />
          <SortHead label={t("trader.cols.duration")} col="duration" className="text-right" {...head} />
          <SortHead label={t("trader.cols.time")} col="time" className="text-right" {...head} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((w) => (
          <TableRow key={w.twapId}>
            <TableCell>
              <Asset coin={w.coin} />
            </TableCell>
            <TableCell className="text-right">
              <Badge tone={w.side === "buy" ? "buy" : "sell"}>{w.side === "buy" ? "Buy" : "Sell"}</Badge>
            </TableCell>
            <TableCell className="text-right">{qty(w.size)}</TableCell>
            <TableCell className="text-right">{(w.filledFraction * 100).toFixed(1)}%</TableCell>
            <TableCell className="text-right">{duration(w.minutes * 60)}</TableCell>
            <TableCell className="text-right">{shortTime(w.startedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- 轉帳 -------------------------------------------------------------------------

/** CopyDog's 類型 labels (English in every locale, as on CopyDog). */
export const TRANSFER_LABEL: Record<TraderTransfer["kind"], string> = {
  deposit: "Deposit",
  withdraw: "Withdrawal",
  sent: "Sent",
  received: "Received",
  generic: "Transfer",
  toHyperEvm: "To HyperEVM",
  toPerp: "To Perp",
  fromPerp: "From Perp",
  toSubaccount: "To Subaccount",
  vaultDeposit: "Vault Deposit",
  vaultWithdraw: "Vault Withdrawal",
  vaultCreate: "Vault Created",
  vaultDistribution: "Vault Distribution",
  commission: "Commission",
  staked: "Staked",
  unstaked: "Unstaked",
  genesis: "Genesis",
  rewards: "Rewards Claimed",
  liquidated: "Liquidation",
  delegationSent: "Delegation Sent",
  delegationReceived: "Delegation Received",
  dexAbstraction: "Dex Abstraction",
};

type TransferKey = "time" | "type" | "asset" | "amount" | "from" | "to" | "hash";
const TRANSFER_KEYS: Record<TransferKey, (x: TraderTransfer) => number | string> = {
  time: (x) => new Date(x.time).getTime(),
  type: (x) => TRANSFER_LABEL[x.kind],
  asset: (x) => x.token,
  amount: (x) => x.amount,
  from: (x) => x.from ?? "",
  to: (x) => x.to ?? "",
  hash: (x) => x.hash,
};

/** 轉帳: 90 days of ledger updates, 時間 / 類型 / 資產 / 數量 / 來源 / 目標 /
 * 雜湊, newest first. */
export function TransfersTab({ address }: { address: string }) {
  const { t } = useI18n();
  const query = useTraderTransfers(address);
  const rows = query.data?.transfers ?? [];
  const { sorted, sort, onSort } = useSorted<TraderTransfer, TransferKey>(rows, TRANSFER_KEYS, { key: "time", dir: "desc" });
  if (query.isError && !query.data) return <LoadError onRetry={() => query.refetch()} />;
  if (!query.data) return <Loading />;
  if (rows.length === 0) return <Empty title={t("trader.empty.transfersTitle")} body={t("trader.empty.transfersDesc")} />;
  const head = { sort, onSort };
  const party = (who: string | null) => (who ? (who === address.toLowerCase() ? t("trader.self") : shortHex(who)) : "-");
  // CopyDog: a bridge deposit or withdrawal has no token and no parties, so
  // it reads as coloured dollars ("$10,349.00") with "-" on both sides.
  const bridge = (x: TraderTransfer) => x.kind === "deposit" || x.kind === "withdraw";
  return (
    <div>
      <Table dense className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <SortHead label={t("trader.cols.time")} col="time" {...head} />
            <SortHead label={t("trader.cols.type")} col="type" {...head} />
            <SortHead label={t("trader.cols.coin")} col="asset" className="text-right" {...head} />
            <SortHead label={t("trader.cols.amount")} col="amount" className="text-right" {...head} />
            <SortHead label={t("trader.cols.from")} col="from" className="text-right" {...head} />
            <SortHead label={t("trader.cols.to")} col="to" className="text-right" {...head} />
            <SortHead label={t("trader.cols.hash")} col="hash" className="text-right" {...head} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((x, i) => (
            <TableRow key={`${x.hash}-${i}`}>
              <TableCell>{shortTime(x.time)}</TableCell>
              <TableCell>
                <Badge tone={x.direction === "in" ? "buy" : x.direction === "out" ? "sell" : "move"}>{TRANSFER_LABEL[x.kind]}</Badge>
              </TableCell>
              <TableCell className="text-right">
                <span className="inline-flex items-center gap-2 align-middle">
                  <CoinIcon coin={x.token} size={16} />
                  {x.token}
                </span>
              </TableCell>
              <TableCell className={cn("text-right", x.usd || bridge(x) ? (x.direction === "out" ? "text-negative" : x.direction === "in" ? "text-positive" : "") : "")}>
                {x.usd || bridge(x) ? usdFull(x.amount) : qty(x.amount)}
              </TableCell>
              <TableCell className="text-right font-mono">{bridge(x) ? "-" : party(x.from)}</TableCell>
              <TableCell className="text-right font-mono">{bridge(x) ? "-" : party(x.to)}</TableCell>
              <TableCell className="text-right">
                {x.hash && !/^0x0+$/.test(x.hash) ? (
                  <a
                    href={`https://app.hyperliquid.xyz/explorer/tx/${x.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-subtle-foreground hover:text-foreground hover:underline"
                  >
                    {shortHex(x.hash)}
                  </a>
                ) : (
                  "—"
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

