"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "cn";

import { TableHead } from "@/components/ui/table";

export type SortDir = "asc" | "desc";
/** The table's sort: a column and its direction; `key: null` is unsorted. */
export interface SortState<K extends string> {
  key: K | null;
  dir: SortDir;
}

/**
 * The one sortable column header (every sortable `ui/Table`): the label as
 * a button, the sorted column in the foreground with an arrow for its
 * direction (no weight change), and `aria-sort` on every sortable header —
 * `ascending` / `descending` on the sorted one, `none` on the others.
 */
export function SortHead<K extends string>({
  label,
  col,
  sort,
  onSort,
  className,
  title,
}: {
  label: ReactNode;
  col: K;
  sort: SortState<K>;
  onSort: (col: K) => void;
  className?: string;
  /** The button's tooltip (e.g. what the column means). */
  title?: string;
}) {
  const active = sort.key === col;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(col)}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          active && "text-foreground",
        )}
      >
        {label}
        {active ? <Arrow aria-hidden className="size-3 text-primary-text" /> : null}
      </button>
    </TableHead>
  );
}

/** Rows sorted client-side by `keys[sort.key]`: a click on the sorted
 * column flips its direction, another column sorts descending. Numbers
 * compare as numbers, anything else as text. */
export function useSorted<T, K extends string>(rows: readonly T[], keys: Record<K, (row: T) => number | string>, initial: { key: K; dir: SortDir }) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir }>(initial);
  const sorted = useMemo(() => {
    const get = keys[sort.key];
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, keys, sort]);
  const onSort = (key: K) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  return { sorted, sort, onSort };
}
