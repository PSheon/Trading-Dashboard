"use client";

import { cn } from "cn";

import { SkelBar } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface SkeletonColumn {
  /** The column's real header (static text reads the same loaded or not). */
  label?: string;
  right?: boolean;
  /** The bar's width in the cells (Tailwind class); varied per column. */
  bar?: string;
  /** The loaded column's own classes (responsive hiding, widths). */
  className?: string;
}

const WIDTHS = ["w-20", "w-14", "w-16", "w-12", "w-[72px]", "w-10"];

/**
 * A table while its rows load: the real `Table` (same header, the same 60px
 * raised rows and 6px gaps, the same gutters; its scroll box unfocusable)
 * with a bar in each cell, and one shimmer over it. `rows` is what a loaded
 * table usually shows on screen.
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
      <Table dense={dense} focusable={false} containerClassName="overflow-x-hidden" className={tableClassName}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((c, i) => (
              <TableHead key={i} className={cn(c.right && "text-right", c.className)}>
                {c.label ?? <SkelBar className="inline-block h-2.5 w-12 align-middle" />}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, r) => (
            <TableRow key={r}>
              {columns.map((c, i) => (
                <TableCell key={i} className={c.className}>
                  <SkelBar className={cn("h-3", c.bar ?? WIDTHS[(i + r) % WIDTHS.length], c.right && "ml-auto")} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
