"use client"

import * as React from "react"
import { cn } from "cn"

import { rovingFocus } from "@/lib/roving-focus"
import { useSlidingIndicator } from "@/lib/use-sliding-indicator"

export interface TabItem<T extends string> {
  value: T
  label: React.ReactNode
  /** Extra content after the label (a count). */
  badge?: React.ReactNode
}

/**
 * The site's one tab row (web audit §三 1): 44 px pills, 15 px labels, the
 * chosen tab under an orange pill that slides to it (the same motion as the
 * chart switches, lib/use-sliding-indicator), with roving focus and
 * role=tablist / tab. `idPrefix` gives each tab the id `${idPrefix}-${value}`
 * (for a panel's aria-labelledby); `controls` is the panel's id.
 * `size="sm"` is the 36 px row used inside cards and dialogs.
 */
function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  idPrefix,
  controls,
  size = "md",
  className,
}: {
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<TabItem<T>>
  label: string
  idPrefix?: string
  controls?: string
  size?: "md" | "sm"
  className?: string
}) {
  const [ref, pill] = useSlidingIndicator<HTMLDivElement>(value)
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className={cn("relative flex min-w-0 items-center gap-1 overflow-x-auto no-scrollbar", className)}
    >
      {pill ? (
        <span
          aria-hidden
          data-tab-pill
          className="pointer-events-none absolute rounded-full bg-primary transition-[left,top,width,height] duration-300 ease-(--ease-orbit) motion-reduce:transition-none"
          style={{ left: pill.left, top: pill.top, width: pill.width, height: pill.height }}
        />
      ) : null}
      {items.map((item) => {
        const active = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-${item.value}` : undefined}
            aria-controls={controls}
            aria-selected={active}
            data-active={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={rovingFocus}
            onClick={() => onChange(item.value)}
            className={cn(
              "relative inline-flex shrink-0 items-center gap-1.5 rounded-full whitespace-nowrap outline-none transition-colors duration-200 ease-(--ease-orbit) focus-visible:ring-2 focus-visible:ring-ring",
              size === "md" ? "h-11 px-4 text-[15px]" : "h-9 px-3.5 text-[13px]",
              active
                ? cn("font-extrabold text-primary-foreground", !pill && "bg-primary")
                : "font-bold text-muted-foreground hover:bg-raised hover:text-foreground"
            )}
          >
            {item.label}
            {item.badge}
          </button>
        )
      })}
    </div>
  )
}

export { Tabs }
