"use client"

import * as React from "react"
import { cn } from "cn"
import { Tooltip as Primitive } from "radix-ui"

/** Minimal tooltip. Wrap disabled buttons in a <span> so they still get
 * pointer events for the hover. */
function Tooltip({
  content,
  children,
  side = "bottom",
  variant = "bubble",
}: {
  content: React.ReactNode
  children: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  /** "chip": CopyDog's small inverted label over icons and times. */
  variant?: "bubble" | "chip"
}) {
  return (
    <Primitive.Provider delayDuration={200}>
      <Primitive.Root>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            side={side}
            sideOffset={variant === "chip" ? 6 : 8}
            className={cn(
              // No exit animation: a closed tooltip whose fade-out never
              // started (Chrome left it pending at 0 ms, 2026-10-07) stayed
              // mounted as the top layer, and took the Escape meant for the
              // dialog around it. It now leaves at once.
              "z-50 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
              variant === "chip"
                ? "rounded-md bg-foreground px-2.5 py-1 text-[11px] font-extrabold whitespace-nowrap text-background"
                : "max-w-64 rounded-lg bg-popover px-3.5 py-2.5 text-xs leading-relaxed font-bold text-popover-foreground shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)]"
            )}
          >
            {content}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  )
}

export { Tooltip }
