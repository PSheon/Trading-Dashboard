"use client"

import * as React from "react"
import { type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

import { buttonVariants } from "./button-variants"
import { OrbitSpinner } from "./orbit-spinner"

/**
 * The Orbit pill button (styles: ./button-variants, which server components
 * import directly). A client component: `loading` keeps state.
 * `loading`: the button keeps its colour and width, can't be pressed again,
 * and its icon (or, without one, a place before the label) shows Orbie's
 * orbit mark for at least BUSY_MIN_MS, so a fast answer doesn't flash.
 */
const BUSY_MIN_MS = 300

/** True while `loading`, and for at least BUSY_MIN_MS once it started: the
 * hold starts with the render that turns `loading` on (React's "adjust state
 * when a prop changes" pattern) and is released by a timer. */
function useBusy(loading: boolean) {
  const [hold, setHold] = React.useState(loading)
  const [wasLoading, setWasLoading] = React.useState(loading)
  if (loading !== wasLoading) {
    setWasLoading(loading)
    if (loading) setHold(true)
  }
  const since = React.useRef(0)
  React.useEffect(() => {
    if (loading) { since.current = Date.now(); return }
    if (!hold) return
    const timer = setTimeout(() => setHold(false), Math.max(0, BUSY_MIN_MS - (Date.now() - since.current)))
    return () => clearTimeout(timer)
  }, [loading, hold])
  return loading || hold
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  ref,
  style,
  onClick,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** A pending action: Orbie's orbit mark, no second press, same width. */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"
  const busy = useBusy(loading)
  const own = React.useRef<HTMLButtonElement | null>(null)
  // The width it had when the action started: the mark never makes it jump.
  const [width, setWidth] = React.useState<number | null>(null)
  React.useLayoutEffect(() => {
    setWidth(busy && own.current ? own.current.getBoundingClientRect().width : null)
  }, [busy])
  const setRef = React.useCallback((node: HTMLButtonElement | null) => {
    own.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }, [ref])

  return (
    <Comp
      ref={setRef}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={busy || undefined}
      aria-busy={busy || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      style={width === null ? style : { ...style, minWidth: width }}
      onClick={busy ? (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault() : onClick}
      {...props}
    >
      {asChild ? children : <>{busy ? <OrbitSpinner /> : null}{children}</>}
    </Comp>
  )
}

export { Button, buttonVariants }
