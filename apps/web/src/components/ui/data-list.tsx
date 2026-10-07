import type { ComponentProps } from "react";
import { cn } from "cn";

type ListTag = "ul" | "ol" | "dl" | "div";

/**
 * The one list of rows that is not a table (activity, transfers, fills,
 * label / value facts) and the phones' card lists:
 * - `rows` (default): rows split by the boards' 2 px dotted rule;
 * - `cards`: a column of cards 8 px apart (each item brings its card).
 *
 * `as` picks the element: `ul` (default), `ol` for a timeline, `dl` for
 * label / value rows (its items are `div`s holding a `dt` and a `dd`).
 * A list longer than a page goes with `usePaged` and the one `TablePager`.
 */
export function DataList({
  as: Tag = "ul",
  variant = "rows",
  className,
  ...props
}: ComponentProps<"ul"> & { as?: ListTag; variant?: "rows" | "cards" }) {
  return (
    <Tag
      data-slot="data-list"
      data-variant={variant}
      className={cn(variant === "rows" ? "divide-y-2 divide-dotted divide-border" : "flex flex-col gap-2", className)}
      {...(props as ComponentProps<"div">)}
    />
  );
}
