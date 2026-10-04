"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { cn } from "cn";

import { EmptyState, ErrorState, Skeleton } from "@/components/page";
import { boardName, TraderAvatar } from "@/components/discover/board-bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import { APP_NAME } from "@/lib/config";
import { coinHref } from "@/lib/coin-slug";
import { coinIsUnknown } from "@/lib/coin-presence";
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
  // CopyDog centres the column in the page (equal side padding), so it
  // gives back the frame's extra 16px on the right.
  return (
    <div className="md:pr-4">
      <div className="w-full max-w-[1068px]">{children}</div>
    </div>
  );
}

// CopyDog's .data-table: mono caps headers (33px), 13px cells in 48–49px rows.
const th = "px-3 pt-1 text-left text-xs leading-4 font-bold whitespace-nowrap text-muted-foreground first:pl-[18px] last:pr-[18px]";
const td = "h-[60px] px-3 text-sm leading-5 font-bold whitespace-nowrap first:pl-[18px] last:pr-[18px]";

export function CoinIndexView() {
  const { t } = useI18n();
  const query = useCoinIndex();
  return (
    <Column>
      <p className="cd-label">{t("coins.markets")}</p>
      <h1 className="mt-1 font-display text-[1.75rem] leading-[1.15] md:text-[2.5rem]">{t("coins.indexTitle")}</h1>
      <p className="mt-2 max-w-[68ch] text-[15px] leading-[1.5] font-bold text-muted-foreground">{t("coins.indexBody")}</p>
      <div className="mt-[31px]">
        {query.isError && !query.data ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.data && query.data.items.length === 0 ? (
          <EmptyState title={t("coins.emptyIndex")} body={t("coins.emptyBody")} />
        ) : (
          <table className="w-full border-separate border-spacing-y-2">
            <thead>
              <tr>
                <th className={th}>{t("coins.colMarket")}</th>
                <th className={cn(th, "text-right")}>{t("coins.colProfitable")}</th>
                <th className={cn(th, "text-right")}>{t("coins.colProfit")}</th>
              </tr>
            </thead>
            <tbody className="data-rows">
              {query.data
                ? query.data.items.map((row) => (
                    <tr key={row.coin} className="relative">
                      <td className={td}>
                        <Link
                          href={coinHref(row.coin)}
                          className="flex items-center gap-2 font-display text-[15px] outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
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
                    <tr key={i}>
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
  // A name that is not a Hyperliquid market is the 404 page (the server
  // decides this first when it can reach the api; see app/coins/[coin]).
  if (coinIsUnknown(query.data) === true) notFound();
  const label = coinLabel(coin);
  // A real market nobody in the pool has traded: CopyDog's page has the
  // heading, one line 「尚無市場資料。」 and no totals or table.
  const noData = query.data !== undefined && query.data.items.length === 0;
  const stats = query.data?.stats;
  return (
    <Column>
      <nav aria-label={t("coins.breadcrumb")} className="text-[0.8125rem] font-bold text-muted-foreground">
        <Link href="/" className="hover:text-foreground">{APP_NAME}</Link>
        <span aria-hidden> › </span>
        <Link href="/coins" className="hover:text-foreground">{t("coins.markets")}</Link>
        <span aria-hidden> › </span>
        <span aria-current="page">{label}</span>
      </nav>
      <h1 className="mt-3 font-display text-[1.75rem] leading-[1.15] md:text-[2.5rem]">{t("coins.title", { coin: label })}</h1>
      <p className="mt-2 max-w-[68ch] text-[15px] leading-[1.5] font-bold text-muted-foreground">{t("coins.body", { coin: label })}</p>

      {noData ? (
        <p data-testid="coin-no-data" className="mt-8 text-sm leading-[1.5] text-muted-foreground">{t("coins.noData")}</p>
      ) : (
      <>
      <dl className="mt-6 flex flex-wrap gap-3">
        {(
          [
            ["coins.listed", stats ? count(stats.traders) : null, ""],
            ["coins.profit", stats ? money(stats.profit) : null, "text-positive"],
            ["coins.volume", stats ? money(stats.volume) : null, ""],
            ["coins.trades", stats ? count(stats.trades) : null, ""],
          ] as const
        ).map(([key, value, tone]) => (
          <div key={key} className="min-w-[150px] rounded-[24px] bg-raised px-4 py-3.5">
            <dt className="cd-label text-muted-foreground">{t(key)}</dt>
            <dd className={cn("num font-display text-2xl leading-[30px]", tone)}>{value ?? <Skeleton className="mt-1 h-6 w-16" />}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-8">
        {query.isError && !query.data ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          // Phones scroll the table sideways, as CopyDog's does.
          <div className="-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0">
            <table className="w-full min-w-[560px] border-separate border-spacing-y-2">
              <thead>
                <tr>
                  <th className={cn(th, "w-[88px]")}>{t("coins.colRank")}</th>
                  <th className={th}>{t("coins.colTrader")}</th>
                  <th className={cn(th, "text-right")}>{t("coins.colPnl")}</th>
                  <th className={cn(th, "text-right")}>{t("coins.colWinRate")}</th>
                  <th className={cn(th, "text-right")}>{t("coins.colTrades")}</th>
                  <th className={cn(th, "text-right")}>{t("coins.colVolume")}</th>
                </tr>
              </thead>
              <tbody className="data-rows">
                {query.data
                  ? query.data.items.map((row, i) => (
                      <tr key={row.address} className="relative">
                        <td className={cn(td, "num")}>{i + 1}</td>
                        <td className={cn(td, "max-w-[260px]")}>
                          <Link
                            href={`/trader/${row.address}`}
                            className="flex min-w-0 items-center gap-2 font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                          >
                            <TraderAvatar trader={row} size={20} />
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
                      <tr key={i}>
                        <td className={td} colSpan={6}><Skeleton className="h-4 w-full" /></td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>
      )}
    </Column>
  );
}
