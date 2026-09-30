"use client";

import { Bell } from "lucide-react";

import { PageHeader, Panel, SignInPrompt, Skeleton } from "@/components/page";
import { TelegramCard } from "@/components/settings/telegram-card";
import { Segmented } from "@/components/ui/segmented";
import { LOCALES, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { useChangeLocale } from "@/lib/use-change-locale";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Panel className="p-5 md:p-6">
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {hint ? <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{hint}</p> : null}
      <div className="mt-5">{children}</div>
    </Panel>
  );
}

/** Language, and Telegram alerts through the official bot. Which traders
 * alert, on which side and from what size is set per favorite (the bell). */
export function SettingsView() {
  const { t, locale } = useI18n();
  const changeLocale = useChangeLocale();
  const { status } = useAuth();

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <PageHeader title={t("settings.title")} />

      <Section title={t("settings.language")} hint={t("settings.languageHint")}>
        <Segmented<Locale>
          variant="pill"
          size="md"
          value={locale}
          onChange={changeLocale}
          options={LOCALES.map((l) => ({ value: l, label: t(`locales.${l}`) }))}
          label={t("settings.language")}
        />
      </Section>

      {status === "signedIn" ? (
        <Panel className="p-5 md:p-6">
          <TelegramCard />
        </Panel>
      ) : status === "loading" ? (
        <Panel className="flex flex-col gap-3 p-5 md:p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-16 w-full" />
        </Panel>
      ) : (
        <Panel>
          <SignInPrompt icon={Bell} title={t("settings.signInTitle")} body={t("settings.signInBody")} />
        </Panel>
      )}
    </div>
  );
}
