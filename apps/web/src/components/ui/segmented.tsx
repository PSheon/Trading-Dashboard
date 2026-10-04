"use client"

import { rovingFocus } from "@/lib/roving-focus"
import { useSlidingIndicator } from "@/lib/use-sliding-indicator"

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
  const [trackRef, pill] = useSlidingIndicator<HTMLDivElement>(value)
  const sliding = variant === "pill" && pill !== null
  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative inline-flex items-center",
        variant === "pill" ? "gap-0.5 rounded-full bg-(--seg-track,var(--raised)) p-1" : "gap-0.5",
        className
      )}
    >
      {sliding ? (
        <span
          aria-hidden
          className="absolute inset-y-1 rounded-full bg-primary transition-[left,width] duration-300 ease-(--ease-orbit) motion-reduce:transition-none"
          style={{ left: pill.left, width: pill.width }}
        />
      ) : null}
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-active={active}
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={rovingFocus}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative rounded-full whitespace-nowrap transition-[background-color,color] duration-200 ease-(--ease-orbit) outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "h-8 px-3 text-[0.8125rem]" : "h-10 px-3.5 text-sm",
              variant === "pill"
                ? active
                  ? cn("font-extrabold text-primary-foreground", !sliding && "bg-primary")
                  : "font-bold text-muted-foreground hover:text-foreground"
                : active
                  ? "font-extrabold text-foreground"
                  : "font-bold text-subtle-foreground hover:text-muted-foreground"
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
