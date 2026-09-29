"use client";

import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { AlertRule, NotificationChannel } from "@trading-dashboard/shared";
import { Bell, Check, Send } from "lucide-react";
import { useState } from "react";

import { ErrorState, PageHeader, Panel, SignInPrompt, Skeleton } from "@/components/page";
import { RuleEditor, type RulePatch } from "@/components/rules/rule-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { LOCALES, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useChangeLocale } from "@/lib/use-change-locale";

const CHAT_ID = /^-?\d{1,20}$/;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Panel className="p-5 md:p-6">
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {hint ? <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{hint}</p> : null}
      <div className="mt-5">{children}</div>
    </Panel>
  );
}

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
        <>
          <TelegramSection />
          <RulesSection />
        </>
      ) : (
        <Panel>
          <SignInPrompt icon={Bell} title={t("settings.signInTitle")} body={t("settings.signInBody")} />
        </Panel>
      )}
    </div>
  );
}

function TelegramSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const channels = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<NotificationChannel[]>("/me/notification-channels"),
    refetchInterval: false,
  });
  const current = channels.data?.find((c) => c.kind === "telegram");
  const save = useMutation<NotificationChannel, ApiError, { target: string; enabled: boolean }>({
    mutationFn: (body) => api.put<NotificationChannel>("/me/notification-channels/telegram", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels"] }),
  });

  return (
    <Section title={t("settings.telegram")} hint={t("settings.telegramHint")}>
      {channels.isPending ? (
        <Skeleton className="h-10 max-w-md" />
      ) : channels.isError ? (
        <ErrorState message={channels.error.message} onRetry={() => channels.refetch()} />
      ) : (
        <TelegramForm key={current ? `${current.target}-${current.enabled}` : "new"} current={current} save={save} />
      )}
    </Section>
  );
}

function TelegramForm({
  current,
  save,
}: {
  current: NotificationChannel | undefined;
  save: UseMutationResult<NotificationChannel, ApiError, { target: string; enabled: boolean }>;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState(current?.target ?? "");
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [touched, setTouched] = useState(false);
  const invalid = touched && !CHAT_ID.test(target.trim());

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (CHAT_ID.test(target.trim())) save.mutate({ target: target.trim(), enabled });
      }}
    >
      <div className="grid max-w-md gap-2">
        <Label htmlFor="chat-id">{t("settings.chatId")}</Label>
        <Input
          id="chat-id"
          inputMode="numeric"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value.trim());
            save.reset();
          }}
          onBlur={() => setTouched(true)}
          placeholder="123456789"
          aria-invalid={invalid || undefined}
          className="font-mono"
        />
        {invalid ? <p className="text-xs text-negative">{t("settings.chatIdInvalid")}</p> : null}
      </div>
      <label className="flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save.reset();
          }}
          className="size-4 accent-[var(--primary)]"
        />
        {t("settings.notificationsOn")}
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          <Send />
          {save.isPending ? t("common.saving") : t("common.save")}
        </Button>
        {save.isSuccess ? (
          <span className="flex items-center gap-1 text-xs text-positive">
            <Check className="size-3.5" />
            {t("common.saved")}
          </span>
        ) : null}
        {save.isError ? <span className="text-xs text-negative">{save.error.message}</span> : null}
      </div>
    </form>
  );
}

function RulesSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ["my-rules"],
    queryFn: () => api.get<AlertRule[]>("/me/alert-rules"),
    refetchInterval: false,
  });
  const save = useMutation<AlertRule, ApiError, { id: number; patch: RulePatch }>({
    mutationFn: ({ id, patch }) => api.patch<AlertRule>(`/me/alert-rules/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-rules"] }),
  });

  return (
    <Section title={t("settings.rules")} hint={t("settings.rulesHint")}>
      {rules.isError ? (
        <ErrorState message={rules.error.message} onRetry={() => rules.refetch()} />
      ) : !rules.data ? (
        <Skeleton className="h-40" />
      ) : rules.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("settings.noRules")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rules.data.map((rule) => (
            <RuleEditor
              key={`${rule.id}-${JSON.stringify(rule)}`}
              rule={rule}
              saving={save.isPending && save.variables?.id === rule.id}
              error={save.isError && save.variables?.id === rule.id ? save.error.message : undefined}
              onSave={(patch) => save.mutate({ id: rule.id, patch })}
            />
          ))}
        </div>
      )}
    </Section>
  );
}
