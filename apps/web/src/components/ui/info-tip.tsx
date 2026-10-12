"use client"

import * as React from "react"
import { Info, type LucideIcon } from "lucide-react"
import { cn } from "cn"
import { Popover as Primitive } from "radix-ui"

/**
 * The one place an explanation lives (UI text density review 2026-10-12):
 * a small ⓘ that shows its text on hover, on keyboard focus and on tap,
 * instead of a grey sentence that is always on screen.
 *
 * - A real `<button>` with `aria-label`, so it is reachable by Tab.
 * - Its text is also in a visually hidden span the button points to with
 *   `aria-describedby`: screen readers (and server markup) always have it;
 *   the bubble is the visual copy only.
 * - Safe inside a card that is a link: a press never follows the link.
 */
function InfoTip({
  label,
  children,
  icon: Icon = Info,
  side = "top",
  align = "center",
  className,
  iconClassName,
  id: descriptionId,
}: {
  /** The hidden description's id, for a field that is described by it too. */
  id?: string
  /** What the button is (its accessible name): short. */
  label: string
  /** The explanation. */
  children: React.ReactNode
  icon?: LucideIcon
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  className?: string
  iconClassName?: string
}) {
  const [open, setOpen] = React.useState(false)
  const trigger = React.useRef<HTMLButtonElement>(null)
  // The last pointer that pressed the button: a mouse already opened the
  // bubble by hovering, so its click keeps it open; a finger toggles it.
  const pointer = React.useRef<string | null>(null)
  const generated = React.useId()
  const id = descriptionId ?? generated
  const stop = (e: React.SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Anchor asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={label}
          aria-describedby={id}
          aria-expanded={open}
          data-state={open ? "open" : "closed"}
          className={cn(
            "inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-full align-middle text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground",
            className
          )}
          onPointerEnter={(e) => { if (e.pointerType === "mouse") setOpen(true) }}
          onPointerLeave={(e) => { if (e.pointerType === "mouse") setOpen(false) }}
          onPointerDown={(e) => { pointer.current = e.pointerType; e.stopPropagation() }}
          onFocus={() => { if (pointer.current === null) setOpen(true) }}
          onBlur={() => { pointer.current = null; setOpen(false) }}
          onClick={(e) => {
            stop(e)
            if (pointer.current === "mouse") setOpen(true)
            else setOpen((o) => !o)
            pointer.current = null
          }}
        >
          <Icon className={cn("size-3.5", iconClassName)} strokeWidth={2.4} aria-hidden />
        </button>
      </Primitive.Anchor>
      <span id={id} className="sr-only">{children}</span>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          aria-hidden
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => { if (trigger.current?.contains(e.target as Node)) e.preventDefault() }}
          // The bubble is portalled, but React still bubbles its events to
          // the card around the button: a tap on it must not open the card.
          onClick={stop}
          data-testid="info-tip-content"
          className="z-50 max-w-64 rounded-lg bg-popover px-3.5 py-2.5 text-xs leading-relaxed font-bold text-popover-foreground shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  )
}

export { InfoTip }
