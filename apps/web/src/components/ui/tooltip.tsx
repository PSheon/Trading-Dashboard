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
              "z-50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
              variant === "chip"
                ? "rounded-md bg-foreground px-2 py-1 text-[11px] font-semibold whitespace-nowrap text-background"
                : "max-w-64 rounded-xl border border-border-strong bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-xl shadow-black/60"
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
