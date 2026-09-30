"use client"

import * as React from "react"
import { cn } from "cn"

/** Dense data table: muted small-caps-ish headers, hairline rows, tabular
 * figures. */
function Table({
  className,
  dense = false,
  ...props
}: React.ComponentProps<"table"> & {
  /** CopyDog's trader-page tables: 6 px cell gutters (12 px at the row
   * ends) and 11 px headers, so eight columns fit the main column. */
  dense?: boolean
}) {
  return (
    // A horizontal scroll container with a visible thin scrollbar: when the
    // columns don't fit (narrow desktops, tablets) the table scrolls inside
    // its card instead of being clipped by it.
    <div
      data-slot="table-container"
      tabIndex={0}
      className={cn(
        "table-scroll relative w-full overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring",
        dense && "table-dense",
      )}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-[0.8125rem] num", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border/70 transition-colors hover:bg-raised/60 has-aria-expanded:bg-raised/60 data-[state=selected]:bg-raised",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4 md:px-3 md:first:pl-5 md:last:pr-5",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("h-12 px-2 align-middle whitespace-nowrap first:pl-4 last:pr-4 md:px-3 md:first:pl-5 md:last:pr-5", className)}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  )
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption }
