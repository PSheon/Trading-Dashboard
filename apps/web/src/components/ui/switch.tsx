"use client";

import type { ComponentProps } from "react";
import { cn } from "cn";

type SwitchProps = Omit<ComponentProps<"button">, "type" | "role" | "aria-checked" | "onClick" | "onChange"> & {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
};

/**
 * An on / off control: a button with `role="switch"` and `aria-checked`,
 * pressed (click, Space, Enter) to flip. It draws nothing itself: the
 * children are the visible switch (usually a `SwitchTrack`, with or without
 * its words), so the whole pill or row can be the press target. Name it with
 * its text, `aria-label` or `aria-labelledby`.
 */
export function Switch({ checked, onCheckedChange, children, ...props }: SwitchProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} {...props}>
      {children}
    </button>
  );
}

/** The small 36×20 track and its sliding knob, inside a `Switch`. */
export function SwitchTrack({ checked }: { checked: boolean }) {
  return (
    <span className={cn("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-primary" : "bg-border-strong")}>
      <span className={cn("absolute top-0.5 size-4 rounded-full bg-foreground transition-[left]", checked ? "left-[18px]" : "left-0.5")} />
    </span>
  );
}
