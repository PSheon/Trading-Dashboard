"use client";

import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { cn } from "cn";

import { useT } from "@/i18n/provider";

/**
 * A side panel over the page: from the right on desktop (32 px corners on
 * its open side), a bottom sheet on phones (24 24 0 0, C-Styles). Radix
 * traps focus, closes on Escape / × / the backdrop and returns focus to the
 * control that opened it.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const t = useT();
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Primitive.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-background text-foreground shadow-[var(--shadow-pop)] outline-none",
            "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[24px] data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom",
            "md:inset-x-auto md:inset-y-0 md:right-0 md:max-h-none md:w-[min(760px,calc(100vw-48px))] md:rounded-t-none md:rounded-l-[32px] md:data-[state=open]:slide-in-from-right md:data-[state=closed]:slide-out-to-right",
            "motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 md:px-[22px] md:pt-[22px]">
            <div className="min-w-0">
              <Primitive.Title className="type-h2 break-words">{title}</Primitive.Title>
              {description ? <Primitive.Description className="type-caption mt-1">{description}</Primitive.Description> : null}
            </div>
            <Primitive.Close
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-raised text-foreground outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("settings.close")}
            >
              <X className="size-[18px]" />
            </Primitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 md:px-[22px]">{children}</div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
