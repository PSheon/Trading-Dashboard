"use client"

import * as React from "react"
import { cn } from "cn"
import { Popover as Primitive } from "radix-ui"

const Popover = Primitive.Root
const PopoverTrigger = Primitive.Trigger
const PopoverAnchor = Primitive.Anchor
const PopoverClose = Primitive.Close

function PopoverContent({
  className,
  sideOffset = 8,
  align = "end",
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="popover-content"
        sideOffset={sideOffset}
        align={align}
        collisionPadding={12}
        className={cn(
          "z-50 w-72 max-w-[calc(100vw-24px)] rounded-2xl bg-popover p-4 text-popover-foreground shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)] outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent }
