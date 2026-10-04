"use client";

import { Globe } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";

import { Lockup } from "@/components/brand/logo";
import { LOCALE_NAMES } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { LanguageMenu } from "./language-menu";

/**
 * The footer card (home, about, help; C-Home board): wordmark and tagline;
 * 資源 (關於我們, 即時動態, 常見問題), 社群 and 法律 columns; a dotted rule,
 * the copyright and the language switch. Channels Orbie doesn't have yet
 * say "coming soon" rather than linking nowhere.
 */
export function SiteFooter({ className }: { className?: string }) {
  const { t, locale } = useI18n();
  const soon = (label: string) => (
    <span className="flex min-h-11 cursor-default items-center font-extrabold text-muted-foreground">
      {label} · {t("home.footer.soon")}
    </span>
  );
  const link = "flex min-h-11 items-center font-extrabold text-foreground transition-colors hover:text-primary-text";
  const heading = "text-xs font-extrabold text-muted-foreground";
  return (
    <footer className={cn("mt-12 flex flex-col gap-5 rounded-3xl bg-raised px-5 pt-7 pb-5 text-[15px] md:px-8", className)}>
      <div className="flex flex-wrap items-start gap-x-5 gap-y-8">
        <div className="flex min-w-[200px] flex-[1_1_240px] flex-col gap-2">
          <Lockup markSize={34} />
          <p className="font-bold text-muted-foreground">{t("home.footer.tagline")}</p>
        </div>
        <nav aria-label={t("home.footer.resources")} className="flex min-w-[120px] flex-col">
          <span className={heading}>{t("home.footer.resources")}</span>
          <Link href="/about" className={link}>{t("home.footer.about")}</Link>
          <Link href="/insights" className={link}>{t("home.footer.live")}</Link>
          <Link href="/help" className={link}>{t("home.footer.faq")}</Link>
        </nav>
        <nav aria-label={t("home.footer.community")} className="flex min-w-[120px] flex-col">
          <span className={heading}>{t("home.footer.community")}</span>
          {soon(t("home.footer.x"))}
          <a href="https://t.me/orbie_fun_bot" target="_blank" rel="noreferrer" className={link}>
            {t("home.footer.telegram")}
          </a>
          {soon(t("home.footer.email"))}
        </nav>
        <nav aria-label={t("home.footer.legal")} className="flex min-w-[120px] flex-col">
          <span className={heading}>{t("home.footer.legal")}</span>
          <Link href="/privacy" className={link}>{t("home.footer.privacy")}</Link>
          <Link href="/terms" className={link}>{t("home.footer.terms")}</Link>
        </nav>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-dotted border-input pt-4">
        <span className="text-[13px] font-bold text-muted-foreground">{t("home.footer.rights")}</span>
        <LanguageMenu
          align="end"
          trigger={
            <button
              type="button"
              aria-label={t("topbar.language")}
              className="orbit-press inline-flex h-11 items-center gap-2 rounded-full bg-card px-4 text-[13px] font-extrabold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Globe className="size-4" strokeWidth={2.4} aria-hidden />
              {LOCALE_NAMES[locale]}
            </button>
          }
        />
      </div>
    </footer>
  );
}
