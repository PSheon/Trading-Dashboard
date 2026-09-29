"use client"

import * as React from "react"
import { cn } from "cn"
import { DropdownMenu as Primitive } from "radix-ui"

const DropdownMenu = Primitive.Root
const DropdownMenuTrigger = Primitive.Trigger
const DropdownMenuGroup = Primitive.Group
const DropdownMenuRadioGroup = Primitive.RadioGroup

function DropdownMenuContent({
  className,
  sideOffset = 8,
  align = "end",
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 min-w-44 overflow-hidden rounded-2xl border border-border-strong bg-popover p-1.5 text-popover-foreground shadow-2xl shadow-black/60 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}

const itemClass =
  "relative flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-raised-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item data-slot="dropdown-menu-item" className={cn(itemClass, className)} {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(itemClass, "pr-8 data-[state=checked]:text-primary", className)}
      {...props}
    >
      {children}
      <Primitive.ItemIndicator className="absolute right-3 size-1.5 rounded-full bg-primary" />
    </Primitive.RadioItem>
  )
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-3 pt-2 pb-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Separator>) {
  return (
    <Primitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1.5 my-1.5 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
}
