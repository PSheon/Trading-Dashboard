import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-xl border border-border bg-raised px-3.5 py-2.5 font-mono text-[0.8125rem] leading-relaxed text-foreground transition-colors outline-none placeholder:text-subtle-foreground hover:border-border-strong focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
