"use client";

import { ChevronRight, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Dialog as Primitive } from "radix-ui";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { LOCALE_NAMES, LOCALES } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { useChangeLocale } from "@/lib/use-change-locale";
import { ThemeChoiceControl } from "./theme-toggle";

/**
 * The menu behind the ☰ on CopyDog's phone marketing pages (about, FAQ,
 * 404): a sheet from the right with the wordmark and ×, a grid of the
 * eleven languages, 排行榜 / 收藏 / 投資組合 / 設定, and 登入 at the bottom
 * while signed out.
 */
export function PhoneMenu() {
  const { t, locale } = useI18n();
  const changeLocale = useChangeLocale();
  const { status, login } = useAuth();
  const [open, setOpen] = useState(false);
  const items = [
    { href: "/explore", label: t("nav.leaderboard") },
    { href: "/favorites", label: t("nav.favorites") },
    { href: "/portfolio", label: t("nav.portfolio") },
    { href: "/settings", label: t("nav.settings") },
  ];
  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Trigger asChild>
        <button
          type="button"
          aria-label={t("nav.openMenu")}
          className="orbit-press flex size-11 shrink-0 flex-col items-center justify-center gap-1 rounded-full bg-raised outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden className="h-0.5 w-4 rounded-full bg-foreground" />
          <span aria-hidden className="h-0.5 w-4 rounded-full bg-foreground" />
          <span aria-hidden className="h-0.5 w-4 rounded-full bg-foreground" />
        </button>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Primitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(82vw,320px)] flex-col overflow-y-auto rounded-l-3xl bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_0_0_2px_var(--card-ring)] outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-300 motion-reduce:animate-none"
        >
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <Primitive.Title className="font-display text-[1.375rem]">{t("nav.menu")}</Primitive.Title>
            <Primitive.Close
              aria-label={t("nav.closeMenu")}
              className="orbit-press flex size-11 items-center justify-center rounded-full bg-inset outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-5" strokeWidth={2.4} />
            </Primitive.Close>
          </div>
          <p className="px-4 pt-1 pb-2 text-xs font-bold text-muted-foreground">{t("topbar.language")}</p>
          <div className="grid grid-cols-2 gap-2 px-4">
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                lang={l}
                title={LOCALE_NAMES[l]}
                aria-label={LOCALE_NAMES[l]}
                aria-pressed={l === locale}
                onClick={() => changeLocale(l)}
                className={cn(
                  "orbit-press flex h-11 items-center justify-center truncate rounded-full px-2 text-sm font-extrabold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  l === locale ? "bg-primary text-primary-foreground" : "bg-inset text-foreground hover:bg-raised-hover",
                )}
              >
                {LOCALE_NAMES[l]}
              </button>
            ))}
          </div>
          <p className="px-4 pt-4 pb-2 text-xs font-bold text-muted-foreground">{t("theme.label")}</p>
          <ThemeChoiceControl className="px-4 [&_button]:bg-inset [&_button[aria-checked=true]]:bg-primary" />
          <nav className="flex flex-col px-4 pt-3">
            {items.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className="flex h-[52px] items-center justify-between border-b-2 border-dotted border-border text-[0.9375rem] font-extrabold outline-none hover:text-primary-text focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
                <ChevronRight className="size-[18px]" strokeWidth={2.4} aria-hidden />
              </Link>
            ))}
          </nav>
          {status === "signedOut" ? (
            <div className="mt-auto p-4 pt-6">
              <Button
                size="xl"
                className="w-full"
                onClick={() => {
                  setOpen(false);
                  login();
                }}
              >
                {t("topbar.login")}
              </Button>
            </div>
          ) : null}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
