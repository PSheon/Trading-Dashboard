"use client";

import { cn } from "cn";

import { SkelBar } from "@/components/page";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";

export interface SkeletonColumn {
  /** The column's real header (static text reads the same loaded or not). */
  label?: string;
  right?: boolean;
  /** The bar's width in the cells (Tailwind class); varied per column. */
  bar?: string;
}

const WIDTHS = ["w-20", "w-14", "w-16", "w-12", "w-[72px]", "w-10"];

/**
 * A table while its rows load: the real table (same header, the same 52px
 * raised rows and 8px gaps, the same gutters) with a bar in each cell, and
 * one shimmer over it. `rows` is what a loaded table usually shows on
 * screen.
 */
export function TableSkeleton({
  columns,
  rows = 6,
  dense = false,
  className,
  tableClassName,
}: {
  columns: SkeletonColumn[];
  rows?: number;
  dense?: boolean;
  className?: string;
  tableClassName?: string;
}) {
  return (
    <div aria-hidden="true" className={cn("ui-skeleton [--skel-bar:var(--border)]", className)}>
      {/* Table's own markup without its focusable scroll box (this copy is
          aria-hidden). */}
      <div className={cn("relative w-full overflow-x-hidden", dense && "table-dense")}>
        <table className={cn("w-full border-separate border-spacing-y-2 caption-bottom text-[0.875rem] font-bold num", tableClassName)}>
          <thead>
            <TableRow className="hover:bg-transparent">
              {columns.map((c, i) => (
                <TableHead key={i} className={c.right ? "text-right" : undefined}>
                  {c.label ?? <SkelBar className="inline-block h-2.5 w-12 align-middle" />}
                </TableHead>
              ))}
            </TableRow>
          </thead>
          <tbody className="data-rows">
            {Array.from({ length: rows }, (_, r) => (
              <TableRow key={r}>
                {columns.map((c, i) => (
                  <TableCell key={i}>
                    <SkelBar className={cn("h-3", c.bar ?? WIDTHS[(i + r) % WIDTHS.length], c.right && "ml-auto")} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
