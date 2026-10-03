"use client";

import { useQueryClient } from "@tanstack/react-query";
import { BellRing, ChevronDown, ExternalLink, Loader2, Send, Unlink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n/provider";
import {
  TELEGRAM_KEY,
  useCreateTelegramLink,
  useTelegramStatus,
  useSetCopyAlerts,
  useTelegramTest,
  useUnlinkTelegram,
} from "@/lib/alerts";
import type { TelegramLinkResponse } from "@/lib/contracts";

/** How often the page asks whether the chat got linked while waiting. */
const POLL_MS = 2_000;

/** Telegram's paper plane in its blue disc, as on CopyDog's rows. */
function TelegramIcon({ className }: { className?: string }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full bg-[#2aabee] text-white", className)} aria-hidden>
      <Send className="size-4 -translate-x-px translate-y-px" />
    </span>
  );
}

/** One notification row: icon, title and hint on the left, action on the right. */
export function BotRow({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string;
  hint: React.ReactNode;
  action: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("py-3.5", className)}>
      <div className="flex items-center gap-3">
        <TelegramIcon />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Opt-in notifications for confirmed paper copy events in the linked chat. */
export function TradingBotRow({ className }: { className?: string }) {
  const { t } = useI18n();
  const status = useTelegramStatus();
  const update = useSetCopyAlerts();
  const data = status.data;
  const canEnable = Boolean(data?.linked && data.enabled && data.bot);
  const checked = data?.copyAlertsEnabled ?? false;
  return <BotRow className={className} title={t("settings.tradingBot")} hint={t("copyUpdates.alertHint")} action={
    status.isError && !data ? <Button variant="secondary" size="sm" onClick={() => status.refetch()}>{t("common.retry")}</Button> :
    !data ? <Skeleton className="h-9 w-16 rounded-full" /> :
    <Button variant="secondary" size="sm" role="switch" aria-checked={checked} aria-label={t("settings.tradingBot")} disabled={update.isPending || (!canEnable && !checked)} onClick={() => update.mutate(!checked)}>
      {t(checked ? "copyUpdates.alertOn" : "copyUpdates.alertOff")}
    </Button>
  }>
    {data && !canEnable ? <p className="mt-2 ml-11 text-xs text-muted-foreground">{t("copyUpdates.alertLink")}</p> : null}
    {update.isError ? <p role="alert" className="mt-2 ml-11 text-xs text-negative">{t("copyUpdates.alertError")}</p> : null}
  </BotRow>;
}

/**
 * 提醒機器人: Orbie's official Telegram alert bot (favorites' trade alerts).
 * - no bot configured → a disabled 連接 with the reason;
 * - not linked → 連接 opens a one-time t.me link in a new tab and polls
 *   GET /me/telegram every 2 s until linked or the link expires (10 min);
 * - linked → "已連接" with a menu: test message, manage alerts, unlink.
 * A failed link and an unlink are CopyDog's toasts (lib/alerts).
 */
export function AlertBotRow({ className }: { className?: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<TelegramLinkResponse | null>(null);
  const status = useTelegramStatus({
    pollMs: POLL_MS,
    pollUntil: pending ? new Date(pending.expiresAt).getTime() : null,
  });
  const create = useCreateTelegramLink();
  const test = useTelegramTest();
  const unlink = useUnlinkTelegram();
  const [confirming, setConfirming] = useState(false);

  const data = status.data;
  const linked = data?.linked ?? false;

  function connect() {
    // Opened inside the click so popup blockers allow it; pointed at the
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

  const hint =
    data && linked
      ? data.enabled
        ? data.username
          ? t("settings.connectedAs", { username: data.username })
          : t("settings.connected")
        : t("settings.paused")
      : t("settings.alertBotHint");

  let action: React.ReactNode;
  if (status.isError && !data) {
    action = (
      <Button variant="secondary" size="sm" onClick={() => status.refetch()}>
        {t("common.retry")}
      </Button>
    );
  } else if (!data) {
    action = <Skeleton className="h-9 w-16 rounded-full" />;
  } else if (!data.bot) {
    action = (
      <Button size="sm" className="bg-foreground text-background hover:bg-foreground/85" disabled title={t("settings.unavailable")}>
        {t("settings.connect")}
      </Button>
    );
  } else if (linked) {
    action = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm">
            {t("settings.connected")}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled={!data.enabled || test.isPending} onSelect={() => test.mutate()}>
            <Send />
            {t("settings.test")}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/favorites">
              <BellRing />
              {t("settings.manageAlerts")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-negative focus:text-negative" onSelect={() => setConfirming(true)}>
            <Unlink />
            {t("settings.unlink")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else {
    action = (
      <Button
        size="sm"
        className="bg-foreground text-background hover:bg-foreground/85"
        onClick={connect}
        disabled={create.isPending}
      >
        {create.isPending ? <Loader2 className="animate-spin" /> : null}
        {create.isPending ? t("settings.connecting") : t("settings.connect")}
      </Button>
    );
  }

  const testResult = test.data
    ? test.data.dryRun
      ? { tone: "text-warning", text: t("settings.testDryRun") }
      : test.data.sent
        ? { tone: "text-positive", text: t("settings.testSent") }
        : { tone: "text-negative", text: t("settings.testFailed") }
    : test.error
      ? { tone: "text-negative", text: t("settings.testFailed") }
      : null;

  return (
    <BotRow className={className} title={t("settings.alertBot")} hint={hint} action={action}>
      {pending && !linked ? (
        <Waiting link={pending} onCancel={() => setPending(null)} onRetry={connect} retrying={create.isPending} />
      ) : null}
      {confirming ? (
        <div className="mt-3 ml-11 flex flex-wrap items-center gap-2 rounded-xl bg-negative-soft px-3 py-2 text-xs text-negative">
          {t("settings.unlinkConfirm")}
          <Button
            size="xs"
            variant="destructive"
            disabled={unlink.isPending}
            // Forget the used link too, so the row starts from 連接 again.
            onClick={() => unlink.mutate(undefined, { onSettled: () => { setConfirming(false); setPending(null); } })}
          >
            {t("settings.unlinkYes")}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
            {t("settings.cancel")}
          </Button>
        </div>
      ) : null}
      {testResult ? <p className={cn("mt-2 ml-11 text-xs", testResult.tone)}>{testResult.text}</p> : null}
    </BotRow>
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
        "mt-3 ml-11 flex flex-col gap-3 rounded-2xl border p-3.5",
        expired ? "border-border bg-raised/40" : "border-primary/30 bg-primary-soft/40",
      )}
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        {expired ? null : <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />}
        <div className="min-w-0">
          <p className="text-[0.8125rem] font-semibold">{expired ? t("settings.expired") : t("settings.waitingTitle")}</p>
          {expired ? null : <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("settings.waitingBody")}</p>}
          {expired ? null : (
            <p className="num mt-1.5 text-xs text-subtle-foreground">{t("settings.expiresIn", { time: `${mm}:${ss}` })}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {expired ? (
          <Button size="sm" onClick={onRetry} disabled={retrying}>
            {t("settings.connect")}
          </Button>
        ) : (
          <Button asChild size="sm">
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              {t("settings.openTelegram")}
            </a>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("settings.cancel")}
        </Button>
      </div>
    </div>
  );
}
