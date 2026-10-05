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
 * Text toggles in a row ("24小時 7天 30天 全部"). `variant="pill"` is the
 * C-Styles segmented control: a track with 26 px corners and 4 px inset
 * around 44 px segments (22 px corners); the active one is orange for a
 * page-level choice, or white (`tone="sub"`) for a sub-tab inside a card.
 * `variant="text"` is the bare chart-header style where only the active
 * label brightens.
 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  variant = "text",
  size = "sm",
  tone = "page",
  className,
  label,
}: {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  variant?: "text" | "pill"
  /** The text variant's size; pill segments are always 44 px. */
  size?: "sm" | "md"
  /** Pill only: `page` = orange active segment, `sub` = white (in a card). */
  tone?: "page" | "sub"
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
        variant === "pill" ? "seg-track" : "gap-0.5",
        className
      )}
    >
      {sliding ? (
        <span
          aria-hidden
          className={cn("absolute rounded-[22px] transition-[left,top,width] duration-300 ease-(--ease-orbit) motion-reduce:transition-none", tone === "sub" ? "bg-card shadow-[0_1px_2px_rgb(21_19_43/8%)]" : "bg-primary")}
          style={{ left: pill.left, top: pill.top, width: pill.width, height: pill.height }}
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
              "relative whitespace-nowrap transition-[background-color,color] duration-200 ease-(--ease-orbit) outline-none focus-visible:ring-2 focus-visible:ring-ring",
              variant === "pill"
                ? "seg-item"
                : cn("rounded-full", size === "sm" ? "h-8 px-3 text-[0.8125rem]" : "h-10 px-3.5 text-sm"),
              variant === "pill"
                ? active
                  ? cn(tone === "sub" ? "text-foreground" : "text-primary-foreground", !sliding && (tone === "sub" ? "bg-card" : "bg-primary"))
                  : "text-muted-foreground hover:text-foreground"
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
