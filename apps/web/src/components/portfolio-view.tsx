"use client";

import { Briefcase, Compass, ShieldCheck, SlidersHorizontal } from "lucide-react";
import Link from "next/link";

import { OrbieMark } from "@/components/brand/logo";
import { PageHeader, Panel } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

/** Portfolio: copy-trading positions will live here; Stage 2 explains it. */
export function PortfolioView() {
  const { t } = useI18n();
  const steps = [
    { icon: Compass, text: t("portfolio.step1") },
    { icon: SlidersHorizontal, text: t("portfolio.step2") },
    { icon: Briefcase, text: t("portfolio.step3") },
  ];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("portfolio.title")} />
      <Panel className="relative overflow-hidden px-6 py-12 md:px-12 md:py-16">
        <div className="pointer-events-none absolute -top-16 -right-16 opacity-[0.07]" aria-hidden>
          <OrbieMark size={360} />
        </div>
        <div className="relative max-w-xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1 text-xs font-semibold text-primary">
            <ShieldCheck className="size-3.5" />
            {t("common.comingSoon")}
          </span>
          <h2 className="mt-4 text-2xl font-extrabold tracking-tight md:text-3xl">{t("portfolio.emptyTitle")}</h2>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">{t("portfolio.emptyBody")}</p>
          <ol className="mt-8 grid gap-3 sm:grid-cols-3">
            {steps.map(({ icon: Icon, text }, i) => (
              <li key={i} className="rounded-2xl bg-raised p-4">
                <div className="flex items-center gap-2 text-primary">
                  <Icon className="size-4" />
                  <span className="num text-xs font-bold">0{i + 1}</span>
                </div>
                <p className="mt-2.5 text-[0.8125rem] leading-relaxed">{text}</p>
              </li>
            ))}
          </ol>
          <Button asChild size="lg" className="mt-8">
            <Link href="/explore">{t("portfolio.cta")}</Link>
          </Button>
        </div>
      </Panel>
    </div>
  );
}
