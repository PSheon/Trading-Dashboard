"use client";

import { Bookmark, Briefcase, List, Settings, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Dialog as Primitive } from "radix-ui";
import { cn } from "cn";

import { Lockup } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { LOCALE_NAMES, LOCALES, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { useChangeLocale } from "@/lib/use-change-locale";

/** CopyDog's short language codes in its phone menu. */
const SHORT: Record<Locale, string> = {
  en: "EN",
  "zh-TW": "繁中",
  "zh-CN": "简中",
  ko: "KO",
  ja: "JA",
  ru: "RU",
  tr: "TR",
  vi: "VI",
  es: "ES",
  pt: "PT",
  id: "ID",
};

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
    { href: "/explore", label: t("nav.leaderboard"), icon: List },
    { href: "/favorites", label: t("nav.favorites"), icon: Bookmark },
    { href: "/portfolio", label: t("nav.portfolio"), icon: Briefcase },
    { href: "/settings", label: t("nav.settings"), icon: Settings },
  ];
  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Trigger asChild>
        <button
          type="button"
          aria-label={t("nav.openMenu")}
          className="flex size-10 shrink-0 flex-col items-center justify-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden className="h-0.5 w-[18px] rounded-full bg-foreground" />
          <span aria-hidden className="h-0.5 w-[18px] rounded-full bg-foreground" />
          <span aria-hidden className="h-0.5 w-[18px] rounded-full bg-foreground" />
        </button>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Primitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(86vw,340px)] flex-col border-l border-border bg-background pb-[env(safe-area-inset-bottom)] outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right"
        >
          <div className="flex items-center justify-between border-b border-border p-4">
            <Primitive.Title asChild>
              <span><Lockup /></span>
            </Primitive.Title>
            <Primitive.Close
              aria-label={t("nav.closeMenu")}
              className="flex size-10 items-center justify-center rounded-full outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-5" />
            </Primitive.Close>
          </div>
          <div className="grid grid-cols-4 gap-2 border-b border-border px-4 py-3">
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
                  "flex h-9 items-center justify-center rounded-xl text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  l === locale ? "bg-foreground text-background" : "bg-raised text-muted-foreground hover:text-foreground",
                )}
              >
                {SHORT[l]}
              </button>
            ))}
          </div>
          <nav className="flex flex-col p-2">
            {items.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className="flex h-12 items-center gap-3 rounded-xl px-4 text-[0.9375rem] font-semibold outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className="size-[18px] text-muted-foreground" aria-hidden />
                {label}
              </Link>
            ))}
          </nav>
          {status === "signedOut" ? (
            <div className="mt-auto border-t border-border p-4">
              <Button
                size="lg"
                className="h-12 w-full"
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
