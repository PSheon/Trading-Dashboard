import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/** The two chips of the token sheet: `sm` (3×9, radius 12, 12 px) for table
 * status, `md` (6×12, radius 16, 13 px) next to card titles and for
 * settings values. */
const badgeVariants = cva(
  "w-fit shrink-0 justify-center overflow-hidden num [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      size: {
        sm: "chip-sm",
        md: "chip-md",
      },
      variant: {
        default: "bg-primary text-primary-foreground",
        positive: "bg-tag-profit text-tag-profit-foreground",
        negative: "bg-tag-loss text-tag-loss-foreground",
        secondary: "bg-(--seg-track,var(--raised)) text-foreground",
        outline: "shadow-[inset_0_0_0_1.5px_var(--input)] text-muted-foreground",
        warning: "bg-tag-warning text-tag-warning-foreground",
        destructive: "bg-tag-loss text-tag-loss-foreground",
        alert: "bg-tag-alert text-tag-alert-foreground",
        ghost: "text-muted-foreground",
        link: "text-primary-text underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "sm",
    },
  }
)

function Badge({
  className,
  variant = "secondary",
  size = "sm",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
