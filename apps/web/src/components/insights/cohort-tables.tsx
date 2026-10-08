"use client";

import { DataList } from "@/components/ui/data-list";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react";
import { TablePager, usePaged } from "@/components/ui/table-pager";
import { SortHead, useSorted } from "@/components/ui/sort-head";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { Link, useRouter } from "@/i18n/navigation";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { CoinStack, CopyScoreBar, signTone, TraderAvatar, VerifiedTick } from "@/components/discover/board-bits";
import { SkelBar, SkelCircle } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import type { CohortMarket, CohortWallet } from "@/lib/contracts";
import { coinLabel, truncateAddress, usdCompact } from "@/lib/format";
import { SentimentText, SplitBar } from "./sentiment";

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
  const router = useRouter();
  const desktop = useIsDesktop();
  const [openWallet, setOpenWallet] = useState<string | null>(null);
  const { sorted, sort, onSort } = useSorted<CohortWallet, WalletKey>(rows, WALLET_KEYS, { key: "perpEquity", dir: "desc" });
  const { rows: pageRows, pager } = usePaged(sorted, `${sort.key}:${sort.dir}`);
  if (rows.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">{t("insights.cohort.tableEmpty")}</p>;
  const c = (key: string) => t(`insights.cohort.cols.${key}` as "insights.cohort.cols.pnl");
  const sortColumns: Record<WalletKey, string> = { address: "address", totalPnl: "pnl", roi: "roi", perpEquity: "perpEquity", copyScore: "copyScore", positionValue: "positionValue", leverage: "leverage", sumUpnl: "upnl", biasPct: "bias" };
  return (
    <>
      {desktop === false ? <>
        <div className="mb-3 flex items-center gap-2">
          <Select size="sm" label={t("discover.sortBy")} className="min-w-0 flex-1" value={sort.key}
            onValueChange={(key) => { if (key !== sort.key) onSort(key); }}
            options={(Object.keys(sortColumns) as WalletKey[]).map((key) => ({ value: key, label: c(sortColumns[key]) }))} />
          <Button variant="secondary" size="icon" aria-label={t(sort.dir === "desc" ? "insights.cohort.sortAscending" : "insights.cohort.sortDescending")}
            onClick={() => onSort(sort.key)}>{sort.dir === "asc" ? <ArrowUp className="size-4" aria-hidden /> : <ArrowDown className="size-4" aria-hidden />}</Button>
        </div>
        <DataList data-testid="cohort-wallets-mobile">
          {pageRows.map((w) => {
            const expanded = openWallet === w.address;
            return <li key={w.address} className="py-3 text-sm">
              <Link href={`/trader/${w.address}`} className="flex min-h-11 min-w-0 items-center gap-2 rounded font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                <TraderAvatar trader={w} size={32} /><span className="min-w-0 truncate">{w.displayName ?? truncateAddress(w.address)}</span>{w.verified ? <VerifiedTick className="size-3.5 shrink-0" /> : null}
              </Link>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                <div><dt className="text-muted-foreground">{c("pnl")}</dt><dd className={cn("num mt-1 font-semibold", signTone(w.totalPnl))}>{money(w.totalPnl, true)}</dd></div>
                <div><dt className="text-muted-foreground">{c("roi")}</dt><dd className={cn("num mt-1 font-semibold", signTone(w.roi))}>{pctText(w.roi)}</dd></div>
                <div className="col-span-2"><dt className="text-muted-foreground">{c("perpEquity")}</dt><dd className="num mt-1 font-semibold">{money(w.perpEquity)}</dd></div>
              </dl>
              <button type="button" aria-expanded={expanded} aria-controls={`cohort-wallet-${w.address}`} onClick={() => setOpenWallet(expanded ? null : w.address)}
                className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-full px-3 font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring">
                {t(expanded ? "common.collapse" : "common.expand")}<ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} aria-hidden />
              </button>
              {expanded ? <dl id={`cohort-wallet-${w.address}`} data-wallet-details className="mt-2 grid gap-3 rounded-xl bg-raised p-3">
                <div><dt className="text-muted-foreground">{c("assets")}</dt><dd className="mt-1"><CoinStack coins={w.topAssets} size={20} dash /></dd></div>
                <div><dt className="text-muted-foreground">{c("copyScore")}</dt><dd className="mt-1"><CopyScoreBar score={w.copyScore} layout="number-first" className="flex items-center gap-2.5" barClassName="w-16" /></dd></div>
                <div><dt className="text-muted-foreground">{c("positionValue")}</dt><dd className="num mt-1 font-semibold">{money(w.positionValue)}</dd></div>
                <div><dt className="text-muted-foreground">{c("leverage")}</dt><dd className="num mt-1 font-semibold">{w.positionValue > 0 && w.leverage !== null ? `${w.leverage.toFixed(2)}×` : "—"}</dd></div>
                <div><dt className="text-muted-foreground">{c("upnl")}</dt><dd className={cn("num mt-1 font-semibold", signTone(w.sumUpnl))}>{money(w.sumUpnl, true)}</dd></div>
                <div><dt className="text-muted-foreground">{c("bias")}</dt><dd className="mt-1">{w.biasPct === null ? "—" : <SentimentText pctLong={w.biasPct} />}</dd></div>
              </dl> : null}
            </li>;
          })}
        </DataList>
      </> : <Table containerClassName="max-h-[640px] overflow-auto" className="cd-cohort-wallets w-full border-separate border-spacing-y-1.5">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <SortHead label={c("address")} col="address" sort={sort} onSort={onSort} className="text-left" />
            <TableHead className="px-3 py-3 text-left text-[0.8125rem] font-medium text-subtle-foreground">{c("assets")}</TableHead>
            <SortHead label={c("pnl")} col="totalPnl" sort={sort} onSort={onSort} className="text-right" />
            <SortHead label={c("roi")} col="roi" sort={sort} onSort={onSort} className="text-right" />
            <SortHead label={c("perpEquity")} col="perpEquity" sort={sort} onSort={onSort} className="text-right" />
            <SortHead label={c("copyScore")} col="copyScore" sort={sort} onSort={onSort} className="text-right" />
            <SortHead label={c("positionValue")} col="positionValue" sort={sort} onSort={onSort} className="text-right" />
            <SortHead label={c("leverage")} col="leverage" sort={sort} onSort={onSort} className="text-right" />
            <SortHead label={c("upnl")} col="sumUpnl" sort={sort} onSort={onSort} className="text-right" />
            <SortHead label={c("bias")} col="biasPct" sort={sort} onSort={onSort} className="text-right" />
          </TableRow>
        </TableHeader>
        <TableBody className="data-rows">
          {pageRows.map((w) => (
            <TableRow
              key={w.address}
              // CopyDog's wallet rows open the trader (the name stays a link).
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a")) return;
                router.push(`/trader/${w.address}`);
              }}
              className="cursor-pointer"
            >
              <TableCell className="px-3 py-3">
                <Link href={`/trader/${w.address}`} className="flex min-w-0 items-center gap-[9px] rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                  <TraderAvatar trader={w} size={22} />
                  {/* CopyDog's .hl-cohort-addr: a bare address is mono 12.5px. */}
                  {w.displayName ? (
                    <span className="max-w-[160px] truncate font-semibold">{w.displayName}</span>
                  ) : (
                    <span className="truncate font-mono text-[12.5px] leading-[18.75px] font-medium">{truncateAddress(w.address)}</span>
                  )}
                  {w.verified ? <VerifiedTick className="size-3.5" /> : null}
                </Link>
              </TableCell>
              <TableCell className="px-3 py-3"><CoinStack coins={w.topAssets} size={16} dash /></TableCell>
              <TableCell className={cn("num px-3 py-3 text-right", signTone(w.totalPnl))}>{money(w.totalPnl, true)}</TableCell>
              <TableCell className={cn("num px-3 py-3 text-right", signTone(w.roi))}>{pctText(w.roi)}</TableCell>
              <TableCell className="num px-3 py-3 text-right">{money(w.perpEquity)}</TableCell>
              <TableCell className="px-3 py-3"><CopyScoreBar score={w.copyScore} layout="number-first" className="flex justify-end gap-2.5" barClassName="w-16" /></TableCell>
              <TableCell className="num px-3 py-3 text-right">{money(w.positionValue)}</TableCell>
              <TableCell className="num px-3 py-3 text-right">{w.positionValue > 0 && w.leverage !== null ? `${w.leverage.toFixed(2)}×` : "—"}</TableCell>
              <TableCell className={cn("num px-3 py-3 text-right", signTone(w.sumUpnl))}>{money(w.sumUpnl, true)}</TableCell>
              <TableCell className="px-3 py-3 text-right">{w.biasPct === null ? "—" : <SentimentText pctLong={w.biasPct} />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>}
    <TablePager {...pager} /></>
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

/** CopyDog's `.hl-cohort-cellsplit`: figure over its share (10.5px), the
 * 4px bar between, gap 12; the row comes to 55px. */
function Split({ left, leftSub, right, rightSub, pos }: { left: string; leftSub: string; right: string; rightSub: string; pos: number | null }) {
  return (
    <div className="flex min-w-[260px] items-center gap-3">
      <span className="flex flex-col">
        <span className="num font-semibold text-positive">{left}</span>
        <span className="mt-px text-[10.5px] leading-[15.75px] font-medium text-subtle-foreground">{leftSub}</span>
      </span>
      <SplitBar pos={pos} className="flex-1" />
      <span className="flex flex-col items-end">
        <span className="num font-semibold text-negative">{right}</span>
        <span className="mt-px text-[10.5px] leading-[15.75px] font-medium text-subtle-foreground">{rightSub}</span>
      </span>
    </div>
  );
}

/** 市場: sentiment, notional long vs short, traders long vs short, and
 * members in profit vs at a loss per market; 全部 / 加密貨幣 / 傳統金融. */
export function MarketsTable({ rows, filter }: { rows: CohortMarket[]; filter: "all" | "crypto" | "tradfi" }) {
  const { t } = useI18n();
  const filtered = useMemo(() => (filter === "crypto" ? rows.filter((r) => !r.coin.includes(":")) : filter === "tradfi" ? rows.filter((r) => r.coin.includes(":")) : rows), [rows, filter]);
  const { sorted, sort, onSort } = useSorted<CohortMarket, MarketKey>(filtered, MARKET_KEYS, { key: "notional", dir: "desc" });
  const { rows: pageRows, pager } = usePaged(sorted, `${filter}:${sort.key}:${sort.dir}`);
  if (filtered.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">{t("insights.cohort.tableEmpty")}</p>;
  const c = (key: string) => t(`insights.cohort.cols.${key}` as "insights.cohort.cols.pnl");
  const long = t("insights.cohort.long");
  const short = t("insights.cohort.short");
  const share = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);
  return (
    <>
      <Table containerClassName="max-h-[640px] overflow-auto" className="cd-cohort-markets w-full min-w-[1080px] border-separate border-spacing-y-1.5">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <SortHead label={c("market")} col="coin" sort={sort} onSort={onSort} className="text-left" />
            <SortHead label={c("sentiment")} col="sentiment" sort={sort} onSort={onSort} className="text-left" />
            <SortHead label={t("insights.cohort.notional")} col="notional" sort={sort} onSort={onSort} className="text-left" />
            <SortHead label={c("traders")} col="traders" sort={sort} onSort={onSort} className="text-left" />
            <SortHead label={c("upnl")} col="upnl" sort={sort} onSort={onSort} className="text-left" />
          </TableRow>
        </TableHeader>
        <TableBody className="data-rows">
          {pageRows.map((m) => {
            const notional = m.notionalLong + m.notionalShort;
            const traders = m.tradersLong + m.tradersShort;
            const pnlTraders = m.tradersProfit + m.tradersLoss;
            return (
              <TableRow key={m.coin}>
                <TableCell className="px-3 py-3">
                  <span className="flex items-center gap-2 font-semibold"><CoinIcon coin={m.coin} size={18} />{coinLabel(m.coin)}</span>
                </TableCell>
                <TableCell className="px-3 py-3"><SentimentText pctLong={m.biasPct} /></TableCell>
                <TableCell className="px-3 py-3">
                  <Split left={usdCompact(m.notionalLong, { digits: 2 })} leftSub={`${share(m.notionalLong, notional)}% ${long}`} right={usdCompact(m.notionalShort, { digits: 2 })} rightSub={`${share(m.notionalShort, notional)}% ${short}`} pos={notional > 0 ? (100 * m.notionalLong) / notional : null} />
                </TableCell>
                <TableCell className="px-3 py-3">
                  <Split left={String(m.tradersLong)} leftSub={`${share(m.tradersLong, traders)}% ${long}`} right={String(m.tradersShort)} rightSub={`${share(m.tradersShort, traders)}% ${short}`} pos={traders > 0 ? (100 * m.tradersLong) / traders : null} />
                </TableCell>
                <TableCell className="px-3 py-3">
                  <Split left={String(m.tradersProfit)} leftSub={`${share(m.tradersProfit, pnlTraders)}% ${t("insights.cohort.profit")}`} right={String(m.tradersLoss)} rightSub={`${share(m.tradersLoss, pnlTraders)}% ${t("insights.cohort.loss")}`} pos={pnlTraders > 0 ? (100 * m.tradersProfit) / pnlTraders : null} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    <TablePager {...pager} /></>
  );
}

/** 錢包 while the tier loads: the same table (header, raised rows, cells'
 * padding) with an avatar and bars in each row. */
export function WalletsTableSkeleton({ rows = 8 }: { rows?: number }) {
  const { t } = useI18n();
  const c = (key: string) => t(`insights.cohort.cols.${key}` as "insights.cohort.cols.pnl");
  const right = ["pnl", "roi", "perpEquity", "copyScore", "positionValue", "leverage", "upnl", "bias"] as const;
  return (
    <div aria-hidden="true" className="ui-skeleton max-h-[640px] overflow-hidden [--skel-bar:var(--border)]">
      <Table className="cd-cohort-wallets w-full border-separate border-spacing-y-1.5">
        <TableHeader>
          <TableRow>
            <TableHead className="px-3 py-3 text-left text-[0.8125rem] font-medium whitespace-nowrap text-subtle-foreground">{c("address")}</TableHead>
            <TableHead className="px-3 py-3 text-left text-[0.8125rem] font-medium text-subtle-foreground">{c("assets")}</TableHead>
            {right.map((k) => <TableHead key={k} className="px-3 py-3 text-right text-[0.8125rem] font-medium whitespace-nowrap text-subtle-foreground">{c(k)}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody className="data-rows">
          {Array.from({ length: rows }, (_, r) => (
            <TableRow key={r}>
              <TableCell className="px-3 py-3">
                <span className="flex items-center gap-[9px]">
                  <SkelCircle className="size-[22px]" />
                  <SkelBar line="h-5" className="h-3 w-24" />
                </span>
              </TableCell>
              <TableCell className="px-3 py-3"><SkelBar className="h-4 w-12" /></TableCell>
              {right.map((k) => <TableCell key={k} className="px-3 py-3"><SkelBar className="ml-auto h-3 w-12" /></TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
