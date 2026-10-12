"use client";

import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import type { BoardTrader } from "@/lib/contracts";

import { boardName, TraderAvatar, VerifiedTick } from "./board-bits";

/**
 * A trader in a list row: avatar and name, each a link to the trader page,
 * with an optional line under the name (stats, groups, an alert summary).
 * The avatar link is named by the trader, so both links read the same.
 */
export function TraderCell({
  trader,
  subtitle,
  size = 44,
}: {
  trader: Pick<BoardTrader, "address" | "avatarUrl" | "displayName" | "verified">;
  subtitle?: ReactNode;
  size?: number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Link href={`/trader/${trader.address}`} className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={boardName(trader)}>
        <TraderAvatar trader={trader} size={size} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link href={`/trader/${trader.address}`} className="flex min-w-0 items-center gap-1 rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          <span className="truncate text-sm font-semibold">{boardName(trader)}</span>
          {trader.verified ? <VerifiedTick className="size-3.5" /> : null}
        </Link>
        {subtitle}
      </div>
    </div>
  );
}
