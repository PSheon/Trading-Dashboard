import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2.5 text-xs font-extrabold whitespace-nowrap num [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        positive: "bg-tag-profit text-tag-profit-foreground",
        negative: "bg-tag-loss text-tag-loss-foreground",
        secondary: "bg-raised text-foreground",
        outline: "border-input text-muted-foreground",
        warning: "bg-tag-warning text-tag-warning-foreground",
        destructive: "bg-tag-loss text-tag-loss-foreground",
        alert: "bg-tag-alert text-tag-alert-foreground",
        ghost: "text-muted-foreground",
        link: "text-primary-text underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  }
)

function Badge({
  className,
  variant = "secondary",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
