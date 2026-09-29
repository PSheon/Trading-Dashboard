import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/** Pill buttons: lime primary, dark raised secondary, quiet ghost. */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-[background-color,color,border-color,transform,opacity] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:not-aria-[haspopup]:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85",
        secondary: "bg-raised text-foreground hover:bg-raised-hover aria-expanded:bg-raised-hover",
        outline:
          "border-border-strong bg-transparent text-foreground hover:bg-raised aria-expanded:bg-raised",
        ghost:
          "text-muted-foreground hover:bg-raised hover:text-foreground aria-expanded:bg-raised aria-expanded:text-foreground",
        destructive: "bg-negative-soft text-negative hover:bg-negative/25",
        link: "rounded-none px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4",
        xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 px-3 text-[0.8125rem] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 px-5 text-[0.9375rem]",
        xl: "h-14 px-6 text-base",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
