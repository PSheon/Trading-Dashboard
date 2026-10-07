"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { Link } from "@/i18n/navigation";
import { notFound } from "next/navigation";
import { cn } from "cn";

import { EmptyState, ErrorState, SkelBar, SkelCircle } from "@/components/page";
import { boardName, TraderAvatar } from "@/components/discover/board-bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import { APP_NAME } from "@/lib/config";
import { coinHref } from "@/lib/coin-slug";
import { coinIsUnknown } from "@/lib/coin-presence";
import { coinLabel, usdCompact } from "@/lib/format";
import type { CoinIndexResponse } from "@/lib/contracts";
import { useCoinBoard, useCoinIndex, type InitialRead } from "@/lib/queries";

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

/** Page column: CopyDog's 1068 px measure, narrower than other pages, so
 * it is centred in the page frame (the frame's edges still match the
 * header's). */
function Column({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1068px]">{children}</div>;
}

// CopyDog's .data-table: mono caps headers (33px), 13px cells in 48–49px rows.

/** `initial`: the index as the server read it (app/coins/page.tsx), so the
 * rows are in the first HTML; without it the browser asks, as before. */
export function CoinIndexView({ initial }: { initial?: InitialRead<CoinIndexResponse> | null } = {}) {
  const query = useCoinIndex(initial);
  return <CoinIndexContent query={{ data: query.data, isError: query.isError, refetch: () => void query.refetch() }} />;
}

/** The page's Suspense fallback while the server reads the index: the same
 * layout with skeleton rows and no query of its own (a query created here
 * would make TanStack ignore the server's initial data on a client
 * navigation, as on the home page). */
export function CoinIndexSkeleton() {
  return <CoinIndexContent query={{ data: undefined, isError: false, refetch: () => {} }} />;
}

function CoinIndexContent({ query }: { query: { data: CoinIndexResponse | undefined; isError: boolean; refetch: () => void } }) {
  const { t } = useI18n();
  return (
    <Column>
      <p className="cd-label">{t("coins.markets")}</p>
      <h1 className="type-h1 mt-1">{t("coins.indexTitle")}</h1>
      <p className="mt-2 max-w-[68ch] text-[15px] leading-[1.5] font-bold text-muted-foreground">{t("coins.indexBody")}</p>
      <div className={cn("mt-[31px]", !query.data && !query.isError && "ui-skeleton")}>
        {query.isError && !query.data ? (
          <ErrorState onRetry={query.refetch} />
        ) : query.data && query.data.items.length === 0 ? (
          <EmptyState title={t("coins.emptyIndex")} body={t("coins.emptyBody")} />
        ) : (
          <Table className="w-full border-separate border-spacing-y-1.5">
            <TableHeader>
              <TableRow>
                <TableHead >{t("coins.colMarket")}</TableHead>
                <TableHead className={cn("text-right")}>{t("coins.colProfitable")}</TableHead>
                <TableHead className={cn("text-right")}>{t("coins.colProfit")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="data-rows">
              {query.data
                ? query.data.items.map((row) => (
                    <TableRow key={row.coin} className="relative">
                      <TableCell >
                        <Link
                          href={coinHref(row.coin)}
                          className="flex items-center gap-2 font-display text-[15px] outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
                        >
                          <CoinIcon coin={row.coin} size={18} />
                          {coinLabel(row.coin)}
                        </Link>
                      </TableCell>
                      <TableCell className={cn("num text-right")}>{count(row.traders)}</TableCell>
                      <TableCell className={cn("num text-right text-positive")}>{money(row.profit)}</TableCell>
                    </TableRow>
                  ))
                : Array.from({ length: 12 }, (_, i) => (
                    <TableRow key={i} aria-hidden="true" className="[--skel-bar:var(--border)]">
                      <TableCell >
                        <span className="flex items-center gap-2">
                          <SkelCircle className="size-[18px]" />
                          <SkelBar className="h-3.5 w-16" />
                        </span>
                      </TableCell>
                      <TableCell ><SkelBar className="ml-auto h-3 w-12" /></TableCell>
                      <TableCell ><SkelBar className="ml-auto h-3 w-20" /></TableCell>
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
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
      <h1 className="type-h1 mt-3">{t("coins.title", { coin: label })}</h1>
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
          <div key={key} className={cn("min-w-[150px] rounded-[24px] bg-raised px-4 py-3.5", value === null && "ui-skeleton [--skel-bar:var(--border)]")}>
            <dt className="cd-label text-muted-foreground">{t(key)}</dt>
            <dd className={cn("num font-display text-2xl leading-[30px]", tone)}>{value ?? <SkelBar line="h-[30px]" className="h-5 w-20" />}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-8">
        {query.isError && !query.data ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          // Phones scroll the table sideways, as CopyDog's does.
          <div className={cn("-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0", !query.data && "ui-skeleton")}>
            <Table className="w-full min-w-[560px] border-separate border-spacing-y-1.5">
              <TableHeader>
                <TableRow>
                  <TableHead className={cn("w-[88px]")}>{t("coins.colRank")}</TableHead>
                  <TableHead >{t("coins.colTrader")}</TableHead>
                  <TableHead className={cn("text-right")}>{t("coins.colPnl")}</TableHead>
                  <TableHead className={cn("text-right")}>{t("coins.colWinRate")}</TableHead>
                  <TableHead className={cn("text-right")}>{t("coins.colTrades")}</TableHead>
                  <TableHead className={cn("text-right")}>{t("coins.colVolume")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="data-rows">
                {query.data
                  ? query.data.items.map((row, i) => (
                      <TableRow key={row.address} className="relative">
                        <TableCell className={cn("num")}>{i + 1}</TableCell>
                        <TableCell className={cn("max-w-[260px]")}>
                          <Link
                            href={`/trader/${row.address}`}
                            className="flex min-w-0 items-center gap-2 font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                          >
                            <TraderAvatar trader={row} size={20} />
                            <span className="truncate">{boardName(row)}</span>
                          </Link>
                        </TableCell>
                        <TableCell className={cn("num text-right text-positive")}>{money(row.pnl)}</TableCell>
                        <TableCell className={cn("num text-right")}>{rate(row.winRate)}</TableCell>
                        <TableCell className={cn("num text-right")}>{count(row.trades)}</TableCell>
                        <TableCell className={cn("num text-right")}>{money(row.volume)}</TableCell>
                      </TableRow>
                    ))
                  : Array.from({ length: 10 }, (_, i) => (
                      <TableRow key={i} aria-hidden="true" className="[--skel-bar:var(--border)]">
                        <TableCell ><SkelBar className="h-3 w-5" /></TableCell>
                        <TableCell className={cn("max-w-[260px]")}>
                          <span className="flex items-center gap-2">
                            <SkelCircle className="size-5" />
                            <SkelBar className="h-3.5 w-24" />
                          </span>
                        </TableCell>
                        <TableCell ><SkelBar className="ml-auto h-3 w-14" /></TableCell>
                        <TableCell ><SkelBar className="ml-auto h-3 w-10" /></TableCell>
                        <TableCell ><SkelBar className="ml-auto h-3 w-8" /></TableCell>
                        <TableCell ><SkelBar className="ml-auto h-3 w-16" /></TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      </>
      )}
    </Column>
  );
}
