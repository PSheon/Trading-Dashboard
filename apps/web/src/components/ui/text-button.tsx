"use client";

import type { ComponentProps } from "react";
import { cn } from "cn";

import { OrbitSpinner } from "./orbit-spinner";

/**
 * A pressable written as words inside a line (重試, 重新整理): underlined
 * text, no pill. `busy`: Orbie's orbit mark before the words, no second
 * press (the busy state of `Button` for a text link).
 */
export function TextButton({ busy = false, className, onClick, children, type = "button", ...props }: ComponentProps<"button"> & { busy?: boolean }) {
  return (
    <button
      type={type}
      aria-busy={busy || undefined}
      data-loading={busy || undefined}
      className={cn("inline-flex items-center gap-1 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring data-[loading=true]:cursor-progress", className)}
      onClick={busy ? (event) => event.preventDefault() : onClick}
      {...props}
    >
      {busy ? <OrbitSpinner className="size-3" /> : null}
      {children}
    </button>
  );
}
