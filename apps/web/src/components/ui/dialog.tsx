"use client";

import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { cn } from "cn";

import { useT } from "@/i18n/provider";
import { keepPanelOpenForNotification } from "./notification-interaction";

/**
 * CopyDog's modal: a ~464 px panel over a dimmed page with a title row, a
 * hairline under it and the body below; × / Escape / the backdrop close it.
 * Radix traps focus and restores it to the trigger on close.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  badge,
  children,
  className,
  bodyClassName,
  bare = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** Shown next to the title (e.g. the testnet badge). */
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** No title row: the body brings its own heading (the title stays for
   * screen readers) and × floats in the corner. CopyDog's export card. */
  bare?: boolean;
}) {
  const t = useT();
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Primitive.Content
          onPointerDownOutside={keepPanelOpenForNotification}
          aria-describedby={undefined}
          tabIndex={-1}
          // Focus the panel, not its first control: that may be a badge whose
          // tooltip would pop open on every opening.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[464px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[32px] bg-popover text-popover-foreground shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)] outline-none [--seg-track:var(--inset)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 motion-reduce:data-[state=open]:zoom-in-100 motion-reduce:data-[state=open]:slide-in-from-bottom-0",
            className,
          )}
        >
          <div className={bare ? "absolute top-3 right-3" : "flex items-center justify-between gap-3 px-6 pt-5 pb-1"}>
            <Primitive.Title className={bare ? "sr-only" : "type-h2 flex items-center gap-2"}>
              {title}
              {badge}
            </Primitive.Title>
            <Primitive.Close
              className="-mr-1 flex size-11 items-center justify-center rounded-full bg-inset text-foreground outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("settings.close")}
            >
              <X className="size-[18px]" />
            </Primitive.Close>
          </div>
          <div className={cn("px-6 pt-4 pb-6", bodyClassName)}>{children}</div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
