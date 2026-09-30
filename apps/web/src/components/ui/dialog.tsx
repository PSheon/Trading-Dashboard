"use client";

import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { cn } from "cn";

import { useT } from "@/i18n/provider";

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** Shown next to the title (e.g. the testnet badge). */
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const t = useT();
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Primitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[464px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border-strong bg-popover text-popover-foreground shadow-2xl shadow-black/60 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            className,
          )}
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <Primitive.Title className="flex items-center gap-2 text-base font-bold">
              {title}
              {badge}
            </Primitive.Title>
            <Primitive.Close
              className="-mr-1 flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("settings.close")}
            >
              <X className="size-[18px]" />
            </Primitive.Close>
          </div>
          <div className={cn("p-5", bodyClassName)}>{children}</div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
