"use client";

import type { SparklinesResponse, TraderStats, TraderWindow } from "@/lib/contracts";
import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";

import { AreaChart } from "@/components/charts/area-chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { TraderName } from "@/components/traders/trader-name";
import { truncateAddress } from "@/lib/format";
import type { TraderSort } from "@/lib/queries";
import { AddressAvatar } from "./address-avatar";
import { ActivityBadge, FavoriteButton, PnlValue, VaultBadge } from "./bits";

type Row = TraderStats & { favorite?: boolean };

export interface SortState {
  sort: TraderSort;
  order: "asc" | "desc";
}

/**
 * Leaderboard table shared by Home (top 10) and Explore (sortable, paged).
 * Rows open the trader page; the star toggles a favorite. Under each name:
 * how recently the account traded (§12).
 */
export function TradersTable({
  rows,
  window,
  rankOffset = 0,
  sparklines,
  sortState,
  onSort,
  showFavorite = true,
  loading = false,
}: {
  rows: Row[];
  window: TraderWindow;
  rankOffset?: number;
  sparklines?: SparklinesResponse;
  sortState?: SortState;
  onSort?: (sort: TraderSort) => void;
  showFavorite?: boolean;
  loading?: boolean;
}) {
  const { t, format } = useI18n();
  const router = useRouter();

  const head = (key: TraderSort, label: string, className?: string) => {
    if (!onSort || !sortState) {
      return <TableHead className={cn("text-right", className)}>{label}</TableHead>;
    }
    const active = sortState.sort === key;
    const Arrow = sortState.order === "desc" ? ArrowDown : ArrowUp;
    return (
      <TableHead
        className={cn("text-right", className)}
        aria-sort={active ? (sortState.order === "desc" ? "descending" : "ascending") : "none"}
      >
        <button
          type="button"
          onClick={() => onSort(key)}
          title={t("explore.sortBy", { column: label })}
          className={cn(
            "inline-flex items-center gap-1 rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            active && "text-foreground",
          )}
        >
          {label}
          {active ? <Arrow className="size-3 text-primary" /> : null}
        </button>
      </TableHead>
    );
  };

  return (
    <Table aria-busy={loading}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-8 md:w-12">{t("explore.cols.rank")}</TableHead>
          <TableHead>{t("explore.cols.trader")}</TableHead>
          {head("accountValue", t("explore.cols.accountValue"), "hidden sm:table-cell")}
          {head("accountPnl", t("explore.cols.accountPnl"))}
          {head("accountRoi", t("explore.cols.accountRoi"))}
          {head("volume", t("explore.cols.volume"), "hidden lg:table-cell")}
          {sparklines ? (
            <TableHead className="hidden w-36 text-right md:table-cell">{t("explore.cols.trend")}</TableHead>
          ) : null}
          {showFavorite ? <TableHead className="w-12" /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => {
          const roi = row.accountRoi[window];
          return (
            <TableRow
              key={row.address}
              className="cursor-pointer"
              onClick={() => router.push(`/trader/${row.address}`)}
            >
              <TableCell className="text-muted-foreground">{rankOffset + i + 1}</TableCell>
              <TableCell>
                <Link
                  href={`/trader/${row.address}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex min-w-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AddressAvatar seed={row.address} size={30} />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="flex max-w-[6.5rem] min-w-0 font-semibold text-foreground sm:max-w-[14rem]">
                        <TraderName trader={row} />
                      </span>
                      {row.isVault ? <VaultBadge /> : null}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-2">
                      {row.displayName ? (
                        <span className="num hidden text-[11px] text-subtle-foreground sm:inline">
                          {truncateAddress(row.address)}
                        </span>
                      ) : null}
                      <ActivityBadge activity={row.activity} />
                    </span>
                  </span>
                </Link>
              </TableCell>
              <TableCell className="hidden text-right sm:table-cell">
                {format.usd(row.accountValue, { compact: true })}
              </TableCell>
              <TableCell className="text-right">
                <PnlValue value={row.accountPnl[window]} />
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-semibold",
                  roi > 0 ? "text-positive" : roi < 0 ? "text-negative" : "text-foreground",
                )}
              >
                {format.pct(roi, { sign: true })}
              </TableCell>
              <TableCell className="hidden text-right text-muted-foreground lg:table-cell">
                {format.usd(row.volume[window], { compact: true })}
              </TableCell>
              {sparklines ? (
                <TableCell className="hidden py-1.5 md:table-cell">
                  <div className="ml-auto w-32">
                    {sparklines[row.address]?.length ? (
                      <AreaChart data={sparklines[row.address]} height={34} strokeWidth={1.5} />
                    ) : (
                      <div className="h-[34px]" />
                    )}
                  </div>
                </TableCell>
              ) : null}
              {showFavorite ? (
                <TableCell className="text-right">
                  <FavoriteButton address={row.address} favorite={Boolean(row.favorite)} size="sm" />
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
