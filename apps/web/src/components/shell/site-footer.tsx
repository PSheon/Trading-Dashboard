"use client";

import { Globe } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";

import { OrbieMark } from "@/components/brand/logo";
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
    <span className="cursor-default font-semibold text-subtle-foreground" title={t("home.footer.soon")}>
      {label}
    </span>
  );
  const link = "font-semibold text-foreground hover:text-muted-foreground";
  const cols = "grid gap-8 md:grid-cols-[minmax(0,1fr)_140px_140px] md:pr-[106px] md:pl-3.5";
  return (
    <footer className={cn("mt-12 pt-8 pb-6 text-sm", className)}>
      <div className={cols}>
        <div className="flex flex-col items-start gap-3">
          <OrbieMark size={28} title="Orbie" />
          <p className="text-muted-foreground">{t("home.footer.tagline")}</p>
          <LanguageMenu
            align="start"
            trigger={
              <button
                type="button"
                aria-label={t("topbar.language")}
                title={LOCALE_NAMES[locale]}
                className="mt-1 inline-flex size-10 items-center justify-center rounded-full bg-raised outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Globe className="size-[18px]" />
              </button>
            }
          />
        </div>
        <nav aria-label={t("home.footer.resources")} className="flex flex-col gap-2.5 text-base">
          <span className="text-sm font-semibold text-subtle-foreground">{t("home.footer.resources")}</span>
          <Link href="/about" className={link}>{t("home.footer.about")}</Link>
          <Link href="/insights" className={link}>{t("home.footer.live")}</Link>
          <Link href="/help" className={link}>{t("home.footer.faq")}</Link>
        </nav>
        <nav aria-label={t("home.footer.community")} className="flex flex-col gap-2.5 text-base">
          <span className="text-sm font-semibold text-subtle-foreground">{t("home.footer.community")}</span>
          {soon(t("home.footer.x"))}
          <a href="https://t.me/orbie_fun_bot" target="_blank" rel="noreferrer" className={link}>
            {t("home.footer.telegram")}
          </a>
          {soon(t("home.footer.email"))}
          {soon(t("home.footer.tgIntel"))}
        </nav>
      </div>
      {/* CopyDog's last row: © on the left, each legal link under a column. */}
      <div className={cn(cols, "mt-14 gap-y-2 text-muted-foreground")}>
        <span>{t("home.footer.rights")}</span>
        <Link href="/privacy" className="hover:text-foreground">{t("home.footer.privacy")}</Link>
        <Link href="/terms" className="hover:text-foreground">{t("home.footer.terms")}</Link>
      </div>
    </footer>
  );
}

