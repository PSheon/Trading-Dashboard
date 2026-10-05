"use client"

import * as React from "react"
import { cn } from "cn"

/** Orbit data table (C-Styles): 12 / 700 muted headers over "data rows" —
 * each row a raised capsule, 60 px high with 18 px ends, 6 px apart;
 * tabular figures. Data tables sit on the page, not in a white card. */
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
        className={cn("w-full border-separate border-spacing-y-1.5 caption-bottom text-[0.875rem] font-bold num", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn(className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody data-slot="table-body" className={cn("data-rows", className)} {...props} />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("font-bold", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "transition-colors",
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
        "h-8 px-2 text-left align-middle text-xs font-bold whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4 md:px-3 md:first:pl-[18px] md:last:pr-[18px]",
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
      className={cn("h-[60px] px-2 align-middle whitespace-nowrap first:pl-4 last:pr-4 md:px-3 md:first:pl-[18px] md:last:pr-[18px]", className)}
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
