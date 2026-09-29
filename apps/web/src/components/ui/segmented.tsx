"use client"

import { rovingFocus } from "@/lib/roving-focus"

import * as React from "react"
import { cn } from "cn"

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
}

/**
 * Text toggles in a row ("24小時 7天 30天 全部"). `variant="pill"` puts the
 * group in a raised track with a filled active segment; `variant="text"`
 * is the bare CopyDog chart-header style where only the active label
 * brightens.
 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  variant = "text",
  size = "sm",
  className,
  label,
}: {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  variant?: "text" | "pill"
  size?: "sm" | "md"
  className?: string
  label?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex items-center",
        variant === "pill" ? "gap-0.5 rounded-full bg-raised p-1" : "gap-0.5",
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={rovingFocus}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-[0.8125rem]",
              variant === "pill"
                ? active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
                : active
                  ? "text-foreground"
                  : "text-subtle-foreground hover:text-muted-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export { Segmented }
