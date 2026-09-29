import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-xl border border-border bg-raised px-3.5 text-base text-foreground transition-colors outline-none file:mr-3 file:inline-flex file:h-7 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:text-xs file:font-semibold file:text-foreground placeholder:text-subtle-foreground hover:border-border-strong focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
