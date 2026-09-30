"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { CoinStack, CopyScoreBar, signTone, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import type { CohortMarket, CohortWallet } from "@/lib/contracts";
import { coinLabel, truncateAddress, usdCompact } from "@/lib/format";
import { SentimentText, SplitBar } from "./sentiment";

type Dir = "asc" | "desc";

function useSort<T, K extends string>(rows: T[], keys: Record<K, (row: T) => number | string>, initial: K) {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<Dir>("desc");
  const sorted = useMemo(() => {
    const get = keys[key];
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : (x as number) - (y as number);
      return dir === "desc" ? -c : c;
    });
  }, [rows, keys, key, dir]);
  const onSort = (next: K) => {
    if (next === key) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setKey(next);
      setDir("desc");
    }
  };
  return { sorted, key, dir, onSort };
}

function Th<K extends string>({ label, col, sort, align = "right" }: { label: string; col: K; sort: { key: K; dir: Dir; onSort: (k: K) => void }; align?: "left" | "right" }) {
  const active = sort.key === col;
  const Icon = sort.dir === "desc" ? ChevronDown : ChevronUp;
  return (
    <th className={cn("px-3 py-3 text-[0.8125rem] font-medium whitespace-nowrap text-subtle-foreground", align === "left" ? "text-left" : "text-right")} aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : undefined}>
      <button type="button" onClick={() => sort.onSort(col)} className={cn("inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", active && "font-bold text-foreground")}>
        {label}
        {active ? <Icon className="size-3" /> : null}
      </button>
    </th>
  );
}

const money = (v: number | null, sign = false) => (v === null ? "—" : usdCompact(v, { sign, digits: 2 }));
const pctText = (ratio: number | null) => {
  if (ratio === null) return "—";
  const p = ratio * 100;
  const body = Math.abs(p) >= 1000 ? Math.round(p).toLocaleString("en-US") : Math.abs(p) >= 100 ? p.toFixed(0) : p.toFixed(1);
  return `${p > 0 ? "+" : ""}${body}%`;
};

type WalletKey = "address" | "totalPnl" | "roi" | "perpEquity" | "copyScore" | "positionValue" | "leverage" | "sumUpnl" | "biasPct";
const WALLET_KEYS: Record<WalletKey, (w: CohortWallet) => number | string> = {
  address: (w) => w.displayName ?? w.address,
  totalPnl: (w) => w.totalPnl ?? -Infinity,
  roi: (w) => w.roi ?? -Infinity,
  perpEquity: (w) => w.perpEquity ?? -Infinity,
  copyScore: (w) => w.copyScore ?? -1,
  positionValue: (w) => w.positionValue,
  leverage: (w) => w.leverage ?? -1,
  sumUpnl: (w) => w.sumUpnl,
  biasPct: (w) => w.biasPct ?? -1,
};

/** 錢包: CopyDog's wallet columns, perp equity first by default. */
export function WalletsTable({ rows }: { rows: CohortWallet[] }) {
  const { t } = useI18n();
  const sort = useSort<CohortWallet, WalletKey>(rows, WALLET_KEYS, "perpEquity");
  if (rows.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">{t("insights.cohort.tableEmpty")}</p>;
  const c = (key: string) => t(`insights.cohort.cols.${key}` as "insights.cohort.cols.pnl");
  return (
    <div className="max-h-[640px] overflow-auto">
      <table className="w-full min-w-[1080px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 border-b border-border bg-card">
          <tr>
            <Th label={c("address")} col="address" sort={sort} align="left" />
            <th className="px-3 py-3 text-left text-[0.8125rem] font-medium text-subtle-foreground">{c("assets")}</th>
            <Th label={c("pnl")} col="totalPnl" sort={sort} />
            <Th label={c("roi")} col="roi" sort={sort} />
            <Th label={c("perpEquity")} col="perpEquity" sort={sort} />
            <Th label={c("copyScore")} col="copyScore" sort={sort} />
            <Th label={c("positionValue")} col="positionValue" sort={sort} />
            <Th label={c("leverage")} col="leverage" sort={sort} />
            <Th label={c("upnl")} col="sumUpnl" sort={sort} />
            <Th label={c("bias")} col="biasPct" sort={sort} />
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((w) => (
            <tr key={w.address} className="border-b border-border transition-colors last:border-0 hover:bg-raised/50">
              <td className="px-3 py-3">
                <Link href={`/trader/${w.address}`} className="flex min-w-0 items-center gap-2 rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                  <TraderAvatar trader={w} size={22} />
                  <span className="max-w-[160px] truncate font-semibold">{w.displayName ?? truncateAddress(w.address)}</span>
                  {w.verified ? <VerifiedTick className="size-3.5" /> : null}
                </Link>
              </td>
              <td className="px-3 py-3"><CoinStack coins={w.topAssets} size={16} dash /></td>
              <td className={cn("num px-3 py-3 text-right", signTone(w.totalPnl))}>{money(w.totalPnl, true)}</td>
              <td className={cn("num px-3 py-3 text-right", signTone(w.roi))}>{pctText(w.roi)}</td>
              <td className="num px-3 py-3 text-right">{money(w.perpEquity)}</td>
              <td className="px-3 py-3"><CopyScoreBar score={w.copyScore} layout="number-first" className="justify-end" /></td>
              <td className="num px-3 py-3 text-right">{money(w.positionValue)}</td>
              <td className="num px-3 py-3 text-right">{w.positionValue > 0 && w.leverage !== null ? `${w.leverage.toFixed(2)}×` : "—"}</td>
              <td className={cn("num px-3 py-3 text-right", signTone(w.sumUpnl))}>{money(w.sumUpnl, true)}</td>
              <td className="px-3 py-3 text-right">{w.biasPct === null ? "—" : <SentimentText pctLong={w.biasPct} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type MarketKey = "coin" | "sentiment" | "notional" | "traders" | "upnl";
const MARKET_KEYS: Record<MarketKey, (m: CohortMarket) => number | string> = {
  coin: (m) => m.coin,
  sentiment: (m) => m.biasPct ?? -1,
  notional: (m) => m.notionalLong + m.notionalShort,
  traders: (m) => m.tradersLong + m.tradersShort,
  upnl: (m) => m.upnl,
};

function Split({ left, leftSub, right, rightSub, pos }: { left: string; leftSub: string; right: string; rightSub: string; pos: number | null }) {
  return (
    <div className="flex min-w-[260px] items-center gap-3">
      <span className="flex flex-col">
        <span className="num font-semibold text-positive">{left}</span>
        <span className="text-[0.6875rem] text-subtle-foreground">{leftSub}</span>
      </span>
      <SplitBar pos={pos} className="flex-1" />
      <span className="flex flex-col items-end">
        <span className="num font-semibold text-negative">{right}</span>
        <span className="text-[0.6875rem] text-subtle-foreground">{rightSub}</span>
      </span>
    </div>
  );
}

/** 市場: sentiment, notional long vs short, traders long vs short, and
 * members in profit vs at a loss per market; 全部 / 加密貨幣 / 傳統金融. */
export function MarketsTable({ rows, filter }: { rows: CohortMarket[]; filter: "all" | "crypto" | "tradfi" }) {
  const { t } = useI18n();
  const filtered = useMemo(() => (filter === "crypto" ? rows.filter((r) => !r.coin.includes(":")) : filter === "tradfi" ? rows.filter((r) => r.coin.includes(":")) : rows), [rows, filter]);
  const sort = useSort<CohortMarket, MarketKey>(filtered, MARKET_KEYS, "notional");
  if (filtered.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">{t("insights.cohort.tableEmpty")}</p>;
  const c = (key: string) => t(`insights.cohort.cols.${key}` as "insights.cohort.cols.pnl");
  const long = t("insights.cohort.long");
  const short = t("insights.cohort.short");
  const share = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);
  return (
    <div className="max-h-[640px] overflow-auto">
      <table className="w-full min-w-[1080px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 border-b border-border bg-card">
          <tr>
            <Th label={c("market")} col="coin" sort={sort} align="left" />
            <Th label={c("sentiment")} col="sentiment" sort={sort} align="left" />
            <Th label={t("insights.cohort.notional")} col="notional" sort={sort} align="left" />
            <Th label={c("traders")} col="traders" sort={sort} align="left" />
            <Th label={c("upnl")} col="upnl" sort={sort} align="left" />
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((m) => {
            const notional = m.notionalLong + m.notionalShort;
            const traders = m.tradersLong + m.tradersShort;
            const pnlTraders = m.tradersProfit + m.tradersLoss;
            return (
              <tr key={m.coin} className="border-b border-border last:border-0">
                <td className="px-3 py-3">
                  <span className="flex items-center gap-2 font-semibold"><CoinIcon coin={m.coin} size={18} />{coinLabel(m.coin)}</span>
                </td>
                <td className="px-3 py-3"><SentimentText pctLong={m.biasPct} /></td>
                <td className="px-3 py-3">
                  <Split left={usdCompact(m.notionalLong, { digits: 2 })} leftSub={`${share(m.notionalLong, notional)}% ${long}`} right={usdCompact(m.notionalShort, { digits: 2 })} rightSub={`${share(m.notionalShort, notional)}% ${short}`} pos={notional > 0 ? (100 * m.notionalLong) / notional : null} />
                </td>
                <td className="px-3 py-3">
                  <Split left={String(m.tradersLong)} leftSub={`${share(m.tradersLong, traders)}% ${long}`} right={String(m.tradersShort)} rightSub={`${share(m.tradersShort, traders)}% ${short}`} pos={traders > 0 ? (100 * m.tradersLong) / traders : null} />
                </td>
                <td className="px-3 py-3">
                  <Split left={String(m.tradersProfit)} leftSub={`${share(m.tradersProfit, pnlTraders)}% ${t("insights.cohort.profit")}`} right={String(m.tradersLoss)} rightSub={`${share(m.tradersLoss, pnlTraders)}% ${t("insights.cohort.loss")}`} pos={pnlTraders > 0 ? (100 * m.tradersProfit) / pnlTraders : null} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
