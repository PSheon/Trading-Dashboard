"use client";

import Link from "next/link";
import { cn } from "cn";

import { EmptyState, ErrorState, Skeleton } from "@/components/page";
import { boardName, TraderAvatar } from "@/components/discover/board-bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import { APP_NAME } from "@/lib/config";
import { coinHref } from "@/lib/coin-slug";
import { coinLabel, usdCompact } from "@/lib/format";
import { useCoinBoard, useCoinIndex } from "@/lib/queries";

/**
 * CopyDog's 市場 pages (`/hyperliquid/coins`, `/hyperliquid/coins/BTC`):
 * the market index and one market's top traders by realized PnL on it,
 * from the api's discovery pool. Figures use CopyDog's formats in every
 * locale: two-decimal K / M / B dollars, one-decimal win rate, grouped
 * counts.
 */

const money = (value: number) => usdCompact(value, { digits: 2 });
const count = (value: number) => value.toLocaleString("en-US");
const rate = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);

/** Page column: CopyDog's 1068 px measure, a little lower than other pages. */
function Column({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1068px] pt-2 md:pt-6">{children}</div>;
}

const th = "h-12 px-3 text-left text-[0.6875rem] font-medium whitespace-nowrap text-muted-foreground";
const td = "px-3 text-sm whitespace-nowrap";

export function CoinIndexView() {
  const { t } = useI18n();
  const query = useCoinIndex();
  return (
    <Column>
      <p className="text-xs font-semibold">{t("coins.markets")}</p>
      <h1 className="mt-2.5 text-[1.625rem] leading-tight font-bold tracking-tight md:text-[1.75rem]">{t("coins.indexTitle")}</h1>
      <p className="mt-2 max-w-[680px] text-[0.9375rem] leading-relaxed text-muted-foreground">{t("coins.indexBody")}</p>
      <div className="mt-8">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.data && query.data.items.length === 0 ? (
          <EmptyState title={t("coins.emptyIndex")} body={t("coins.emptyBody")} />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>{t("coins.colMarket")}</th>
                <th className={cn(th, "text-right")}>{t("coins.colProfitable")}</th>
                <th className={cn(th, "text-right")}>{t("coins.colProfit")}</th>
              </tr>
            </thead>
            <tbody>
              {query.data
                ? query.data.items.map((row) => (
                    <tr key={row.coin} className="relative h-12 border-b border-border transition-colors hover:bg-raised/50">
                      <td className={td}>
                        <Link
                          href={coinHref(row.coin)}
                          className="flex items-center gap-2 font-semibold outline-none after:absolute after:inset-0 focus-visible:underline"
                        >
                          <CoinIcon coin={row.coin} size={18} />
                          {coinLabel(row.coin)}
                        </Link>
                      </td>
                      <td className={cn(td, "num text-right")}>{count(row.traders)}</td>
                      <td className={cn(td, "num text-right text-positive")}>{money(row.profit)}</td>
                    </tr>
                  ))
                : Array.from({ length: 12 }, (_, i) => (
                    <tr key={i} className="h-12 border-b border-border">
                      <td className={td}><Skeleton className="h-4 w-24" /></td>
                      <td className={td}><Skeleton className="ml-auto h-4 w-12" /></td>
                      <td className={td}><Skeleton className="ml-auto h-4 w-16" /></td>
                    </tr>
                  ))}
            </tbody>
          </table>
        )}
      </div>
    </Column>
  );
}

export function CoinBoardView({ coin }: { coin: string }) {
  const { t } = useI18n();
  const query = useCoinBoard(coin);
  const label = coinLabel(coin);
  const stats = query.data?.stats;
  return (
    <Column>
      <nav aria-label={t("coins.breadcrumb")} className="text-[0.8125rem] text-muted-foreground">
        <Link href="/" className="hover:text-foreground">{APP_NAME}</Link>
        <span aria-hidden> › </span>
        <Link href="/coins" className="hover:text-foreground">{t("coins.markets")}</Link>
        <span aria-hidden> › </span>
        <span aria-current="page">{label}</span>
      </nav>
      <h1 className="mt-3 text-[1.625rem] leading-tight font-bold tracking-tight md:text-[1.75rem]">{t("coins.title", { coin: label })}</h1>
      <p className="mt-2 max-w-[660px] text-[0.9375rem] leading-relaxed text-muted-foreground">{t("coins.body", { coin: label })}</p>

      <dl className="mt-7 flex flex-wrap gap-x-8 gap-y-6">
        {(
          [
            ["coins.listed", stats ? count(stats.traders) : null, ""],
            ["coins.profit", stats ? money(stats.profit) : null, "text-positive"],
            ["coins.volume", stats ? money(stats.volume) : null, ""],
            ["coins.trades", stats ? count(stats.trades) : null, ""],
          ] as const
        ).map(([key, value, tone]) => (
          <div key={key} className="min-w-[88px]">
            <dt className="text-[0.6875rem] font-semibold">{t(key)}</dt>
            <dd className={cn("num mt-1 text-xl font-semibold tracking-tight", tone)}>{value ?? <Skeleton className="mt-1 h-6 w-16" />}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-9">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.data && query.data.items.length === 0 ? (
          <EmptyState title={t("coins.empty", { coin: label })} body={t("coins.emptyBody")} />
        ) : (
          // Phones scroll the table sideways, as CopyDog's does.
          <div className="-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(th, "w-[88px]")}>{t("coins.colRank")}</th>
                  <th className={th}>{t("coins.colTrader")}</th>
                  <th className={cn(th, "text-right")}>{t("coins.colPnl")}</th>
                  <th className={cn(th, "text-right")}>{t("coins.colWinRate")}</th>
                  <th className={cn(th, "text-right")}>{t("coins.colTrades")}</th>
                  <th className={cn(th, "text-right")}>{t("coins.colVolume")}</th>
                </tr>
              </thead>
              <tbody>
                {query.data
                  ? query.data.items.map((row, i) => (
                      <tr key={row.address} className="relative h-[49px] border-b border-border transition-colors hover:bg-raised/50">
                        <td className={cn(td, "num")}>{i + 1}</td>
                        <td className={cn(td, "max-w-[260px]")}>
                          <Link
                            href={`/trader/${row.address}`}
                            className="flex min-w-0 items-center gap-2.5 outline-none after:absolute after:inset-0 focus-visible:underline"
                          >
                            <TraderAvatar trader={row} size={24} />
                            <span className="truncate">{boardName(row)}</span>
                          </Link>
                        </td>
                        <td className={cn(td, "num text-right text-positive")}>{money(row.pnl)}</td>
                        <td className={cn(td, "num text-right")}>{rate(row.winRate)}</td>
                        <td className={cn(td, "num text-right")}>{count(row.trades)}</td>
                        <td className={cn(td, "num text-right")}>{money(row.volume)}</td>
                      </tr>
                    ))
                  : Array.from({ length: 10 }, (_, i) => (
                      <tr key={i} className="h-[49px] border-b border-border">
                        <td className={td} colSpan={6}><Skeleton className="h-4 w-full" /></td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Column>
  );
}
