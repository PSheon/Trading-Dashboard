import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-xl border-2 border-transparent bg-inset px-4 text-base font-bold text-foreground transition-colors outline-none file:mr-3 file:inline-flex file:h-7 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:text-xs file:font-semibold file:text-foreground placeholder:font-semibold placeholder:text-subtle-foreground hover:border-input focus-visible:border-primary focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
