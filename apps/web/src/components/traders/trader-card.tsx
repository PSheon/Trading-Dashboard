"use client";

import type { TraderActivity } from "@trading-dashboard/shared";
import Link from "next/link";
import { cn } from "cn";

import { AreaChart, type SeriesPoint } from "@/components/charts/area-chart";
import { useI18n } from "@/i18n/provider";
import { traderName } from "@/lib/format";
import { AddressAvatar } from "./address-avatar";
import { ActivityBadge, PnlValue, RoiPill, VaultBadge } from "./bits";

export interface TraderCardData {
  address: string;
  displayName: string | null;
  isVault: boolean;
  pnl: number | null;
  roi: number | null;
  /** Shown under the name when given (null: not on the leaderboard). */
  activity?: TraderActivity | null;
}

/** Featured trader card: avatar + name (+ how recently it traded), PnL
 * sparkline, PnL and ROI pill. */
export function TraderCard({
  trader,
  series,
  className,
}: {
  trader: TraderCardData;
  series: readonly SeriesPoint[] | undefined;
  className?: string;
}) {
  const { format } = useI18n();
  return (
    <Link
      href={`/trader/${trader.address}`}
      className={cn(
        "group flex w-[196px] shrink-0 snap-start flex-col rounded-2xl bg-raised p-3.5 outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring md:w-[206px]",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AddressAvatar seed={trader.address} size={28} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[0.875rem] font-semibold">{traderName(trader)}</span>
            {trader.isVault ? <VaultBadge /> : null}
          </span>
          {trader.activity ? <ActivityBadge activity={trader.activity} className="mt-1" /> : null}
        </span>
      </div>
      <div className="mt-3 h-[92px]">
        {series && series.length > 1 ? (
          <AreaChart data={series} height={92} strokeWidth={1.75} zeroLine formatValue={(v) => format.usd(v, { compact: true })} />
        ) : (
          <div className="h-full animate-pulse rounded-xl bg-raised-hover/60" />
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <PnlValue value={trader.pnl} className="text-[1.0625rem]" />
        <RoiPill value={trader.roi} />
      </div>
    </Link>
  );
}

export function TraderCardSkeleton() {
  return <div className="h-[178px] w-[196px] shrink-0 animate-pulse rounded-2xl bg-raised md:w-[206px]" />;
}
