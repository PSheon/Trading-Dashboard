"use client";

import { Globe } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";

import { OrbieMark, Wordmark } from "@/components/brand/logo";
import { LOCALE_NAMES } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { LanguageMenu } from "./language-menu";

/**
 * CopyDog's footer (home, about, help): brand, tagline and the language
 * menu; 資源 (關於我們, 即時動態, 常見問題) and 社群 columns; copyright and
 * the legal links. Channels Orbie doesn't have yet show as "coming soon"
 * rather than linking nowhere.
 */
export function SiteFooter({ className }: { className?: string }) {
  const { t, locale } = useI18n();
  const soon = (label: string) => (
    <span className="cursor-default text-subtle-foreground/70" title={t("home.footer.soon")}>
      {label}
    </span>
  );
  const link = "text-muted-foreground hover:text-foreground";
  return (
    <footer className={cn("mt-4 border-t border-border pt-8 pb-4 text-sm", className)}>
      <div className="grid gap-8 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col items-start gap-3">
          <span className="flex items-center gap-2 text-foreground">
            <OrbieMark size={28} />
            <Wordmark className="text-2xl" />
          </span>
          <p className="text-muted-foreground">{t("home.footer.tagline")}</p>
          <LanguageMenu
            align="start"
            trigger={
              <button
                type="button"
                aria-label={t("topbar.language")}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-raised px-3.5 text-[0.8125rem] font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Globe className="size-4" />
                {LOCALE_NAMES[locale]}
              </button>
            }
          />
        </div>
        <nav aria-label={t("home.footer.resources")} className="flex flex-col gap-2.5">
          <span className="font-semibold">{t("home.footer.resources")}</span>
          <Link href="/about" className={link}>{t("home.footer.about")}</Link>
          <Link href="/insights" className={link}>{t("home.footer.live")}</Link>
          <Link href="/help" className={link}>{t("home.footer.faq")}</Link>
        </nav>
        <nav aria-label={t("home.footer.community")} className="flex flex-col gap-2.5">
          <span className="font-semibold">{t("home.footer.community")}</span>
          {soon(t("home.footer.x"))}
          <a href="https://t.me/orbie_fun_bot" target="_blank" rel="noreferrer" className={link}>
            {t("home.footer.telegram")}
          </a>
          {soon(t("home.footer.email"))}
          {soon(t("home.footer.tgIntel"))}
        </nav>
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-subtle-foreground">
        <span>{t("home.footer.rights")}</span>
        <span className="flex gap-4">
          <Link href="/privacy" className="hover:text-foreground">{t("home.footer.privacy")}</Link>
          <Link href="/terms" className="hover:text-foreground">{t("home.footer.terms")}</Link>
        </span>
      </div>
    </footer>
  );
}
