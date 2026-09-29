"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { TelegramLinkResponse, TelegramStatus } from "@/lib/contracts";
import { BellRing, Check, ExternalLink, Loader2, Send, Unlink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { ErrorState, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import {
  TELEGRAM_KEY,
  useCreateTelegramLink,
  useTelegramStatus,
  useTelegramTest,
  useUnlinkTelegram,
} from "@/lib/alerts";
import { apiErrorCode, ApiError } from "@/lib/api";
import { useSiteSettings } from "@/lib/queries";

/** How often the page asks whether the chat got linked while waiting. */
const POLL_MS = 2_000;

/**
 * Telegram card on the settings page (official bot, CopyDog-style):
 * - no bot configured → a disabled explanation;
 * - not linked → what alerts are and "Connect Telegram", which opens a
 *   one-time t.me link in a new tab and polls GET /me/telegram every 2 s
 *   until the chat is linked or the link expires (10 minutes);
 * - linked → @username, when, a test message and unlink.
 */
export function TelegramCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<TelegramLinkResponse | null>(null);
  // Polls only while waiting for Start: until linked or the link expires.
  const status = useTelegramStatus({
    pollMs: POLL_MS,
    pollUntil: pending ? new Date(pending.expiresAt).getTime() : null,
  });
  const create = useCreateTelegramLink();
  const settings = useSiteSettings();


  function connect() {
    // Opened in the click itself so popup blockers allow it; pointed at the
    // t.me link once the api answers.
    const tab = window.open("", "_blank");
    create.mutate(undefined, {
      onSuccess: (link) => {
        if (tab) {
          tab.opener = null;
          tab.location.href = link.url;
        }
        setPending(link);
        void queryClient.invalidateQueries({ queryKey: TELEGRAM_KEY });
      },
      onError: () => tab?.close(),
    });
  }

  const bot = status.data?.bot ?? null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <Send className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-bold tracking-tight">{t("settings.telegram")}</h2>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
            {t("settings.telegramHint", { bot: bot ?? "orbie_fun_bot" })}
          </p>
        </div>
      </div>

      {status.isError ? (
        <ErrorState message={status.error.message} onRetry={() => status.refetch()} />
      ) : !status.data ? (
        <Skeleton className="h-28" />
      ) : !bot ? (
        <Unavailable />
      ) : status.data.linked ? (
        // Linked: the wait (if any) is over; forget the used link so an
        // unlink later starts from "Connect" again.
        <Linked status={status.data} onUnlinked={() => setPending(null)} />
      ) : pending ? (
        <Waiting link={pending} onCancel={() => setPending(null)} onRetry={connect} retrying={create.isPending} />
      ) : (
        <NotLinked
          max={settings.data?.maxAlertTraders ?? 3}
          onConnect={connect}
          connecting={create.isPending}
          error={
            create.error
              ? apiErrorCode(create.error) === "rate_limited"
                ? t("settings.rateLimited")
                : apiErrorCode(create.error) === "telegram_not_configured"
                  ? t("settings.unavailable")
                  : create.error.message
              : undefined
          }
        />
      )}
    </div>
  );
}

function Unavailable() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl bg-raised/60 p-4">
      <p className="text-[0.8125rem] text-muted-foreground">{t("settings.unavailable")}</p>
      <Button disabled>
        <Send />
        {t("settings.connect")}
      </Button>
    </div>
  );
}

function NotLinked({
  max,
  onConnect,
  connecting,
  error,
}: {
  max: number;
  onConnect: () => void;
  connecting: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  const steps = [t("settings.telegramSteps.one"), t("settings.telegramSteps.two"), t("settings.telegramSteps.three")];
  return (
    <div className="flex flex-col gap-4">
      <p className="flex gap-2 rounded-2xl bg-primary-soft/60 p-3.5 text-[0.8125rem] leading-relaxed text-foreground">
        <BellRing className="mt-0.5 size-4 shrink-0 text-primary" />
        {t("settings.telegramIntro", { max })}
      </p>
      <ol className="grid gap-2 sm:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step} className="flex items-start gap-2.5 rounded-xl bg-raised/60 p-3 text-xs leading-relaxed text-muted-foreground">
            <span className="num flex size-5 shrink-0 items-center justify-center rounded-full bg-raised-hover text-[11px] font-bold text-foreground">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onConnect} disabled={connecting}>
          {connecting ? <Loader2 className="animate-spin" /> : <Send />}
          {connecting ? t("settings.connecting") : t("settings.connect")}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function useCountdown(until: Date | string): number {
  const end = new Date(until).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, end - now);
}

function Waiting({
  link,
  onCancel,
  onRetry,
  retrying,
}: {
  link: TelegramLinkResponse;
  onCancel: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useI18n();
  const left = useCountdown(link.expiresAt);
  const expired = left === 0;
  const mm = Math.floor(left / 60_000);
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, "0");

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-2xl border p-4",
        expired ? "border-border bg-raised/40" : "border-primary/30 bg-primary-soft/40",
      )}
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        {expired ? null : <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />}
        <div className="min-w-0">
          <p className="text-sm font-semibold">{expired ? t("settings.expired") : t("settings.waitingTitle")}</p>
          {expired ? null : (
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{t("settings.waitingBody")}</p>
          )}
          {expired ? null : (
            <p className="num mt-2 text-xs text-subtle-foreground">{t("settings.expiresIn", { time: `${mm}:${ss}` })}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {expired ? (
          <Button onClick={onRetry} disabled={retrying}>
            <Send />
            {t("settings.connect")}
          </Button>
        ) : (
          <Button asChild>
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              {t("settings.openTelegram")}
            </a>
          </Button>
        )}
        <Button variant="ghost" onClick={onCancel}>
          {t("settings.cancel")}
        </Button>
      </div>
    </div>
  );
}

function Linked({ status, onUnlinked }: { status: TelegramStatus; onUnlinked: () => void }) {
  const { t, format } = useI18n();
  const test = useTelegramTest();
  const unlink = useUnlinkTelegram();
  const [confirming, setConfirming] = useState(false);

  const testResult = test.data
    ? test.data.dryRun
      ? { tone: "text-warning", text: t("settings.testDryRun") }
      : test.data.sent
        ? { tone: "text-positive", text: t("settings.testSent") }
        : { tone: "text-negative", text: t("settings.testFailed") }
    : test.error
      ? { tone: "text-negative", text: test.error instanceof ApiError && test.error.code ? t("settings.testFailed") : test.error.message }
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-raised/60 p-4">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Send className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {status.username ? `@${status.username}` : t("settings.noUsername")}
            <span
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold",
                status.enabled ? "bg-positive-soft text-positive" : "bg-warning/12 text-warning",
              )}
            >
              {status.enabled ? <Check className="size-3" /> : null}
              {status.enabled ? t("settings.linked") : t("settings.paused")}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {status.linkedAt ? t("settings.linkedAt", { time: format.dateTime(status.linkedAt) }) : null}
            {status.enabled ? ` · ${t("settings.active")}` : null}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href="/favorites">
            <BellRing />
            {t("settings.manageAlerts")}
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !status.enabled}>
          {test.isPending ? <Loader2 className="animate-spin" /> : <Send />}
          {t("settings.test")}
        </Button>
        {confirming ? (
          <span className="flex flex-wrap items-center gap-2 rounded-full bg-negative-soft py-1 pr-1 pl-3 text-xs text-negative">
            {t("settings.unlinkConfirm")}
            <Button
              size="xs"
              variant="destructive"
              disabled={unlink.isPending}
              onClick={() =>
                unlink.mutate(undefined, {
                  onSuccess: onUnlinked,
                  onSettled: () => setConfirming(false),
                })
              }
            >
              {t("settings.unlinkYes")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              {t("settings.cancel")}
            </Button>
          </span>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            <Unlink />
            {t("settings.unlink")}
          </Button>
        )}
        {testResult ? <span className={cn("text-xs", testResult.tone)}>{testResult.text}</span> : null}
      </div>
    </div>
  );
}
