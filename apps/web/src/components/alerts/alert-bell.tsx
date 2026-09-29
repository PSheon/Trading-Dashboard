"use client";

import type { AlertSidesInput, FavoriteAlert } from "@trading-dashboard/shared";
import { Bell, BellRing, Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { useI18n, type Translate } from "@/i18n/provider";
import { useAddFavorite, useSetFavoriteAlert, useTelegramStatus } from "@/lib/alerts";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Formatter } from "@/lib/format";
import { useFavorites, useSiteSettings } from "@/lib/queries";

const SIDE_KEY = { buy: "alerts.sideBuy", sell: "alerts.sideSell", both: "alerts.sideBoth" } as const;

/** "買入 · ≥ $5萬" / "Both · any size" / "Off". */
export function alertSummary(alert: FavoriteAlert, t: Translate, format: Formatter): string {
  if (!alert.enabled) return t("alerts.off");
  const side = t(SIDE_KEY[alert.sides]);
  return alert.minUsd === null
    ? t("alerts.summaryAny", { side })
    : t("alerts.summaryMin", { side, min: format.usd(alert.minUsd, { compact: true }) });
}

/**
 * The bell for one trader: opens a popover to switch its Telegram alert on
 * or off and choose buy / sell / both and a minimum size. On a trader that
 * isn't a favorite yet (trader page) it favorites first. Signed out, it
 * opens the login.
 *
 * `variant="pill"` (favorites rows) shows the current setting next to the
 * bell; `"icon"` (trader page, next to the star) is the bell alone.
 */
export function AlertBell({
  address,
  variant = "icon",
  className,
}: {
  address: string;
  variant?: "icon" | "pill";
  className?: string;
}) {
  const { t, format } = useI18n();
  const { status, login } = useAuth();
  const favorites = useFavorites();
  const addFavorite = useAddFavorite();
  const [open, setOpen] = useState(false);

  const favorite = favorites.data?.find((f) => f.address === address);
  const on = favorite?.alert.enabled ?? false;
  const label =
    status === "signedOut" ? t("alerts.loginToAlert") : on ? t("alerts.edit") : t("alerts.turnOn");
  const Icon = on ? BellRing : Bell;

  function onOpenChange(next: boolean) {
    if (!next) return setOpen(false);
    if (status !== "signedIn") {
      if (status === "signedOut") login();
      return;
    }
    if (!favorites.data) return;
    if (!favorite) {
      addFavorite.mutate(address, { onSuccess: () => setOpen(true) });
      return;
    }
    setOpen(true);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={on}
          disabled={addFavorite.isPending}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            variant === "icon"
              ? "size-7 hover:bg-raised-hover"
              : "h-8 gap-1.5 border px-2.5 text-xs font-semibold whitespace-nowrap",
            variant === "pill" &&
              (on
                ? "border-primary/40 bg-primary-soft text-primary hover:bg-primary/20"
                : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground"),
            variant === "icon" && (on ? "text-primary" : "text-subtle-foreground hover:text-foreground"),
            className,
          )}
        >
          <Icon className={variant === "icon" ? "size-4" : "size-3.5"} />
          {variant === "pill" && favorite ? <span>{alertSummary(favorite.alert, t, format)}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent onClick={(e) => e.stopPropagation()} aria-label={t("alerts.title")}>
        {favorite ? (
          <AlertEditor key={JSON.stringify(favorite.alert)} address={address} alert={favorite.alert} onDone={() => setOpen(false)} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function AlertEditor({ address, alert, onDone }: { address: string; alert: FavoriteAlert; onDone: () => void }) {
  const { t } = useI18n();
  const telegram = useTelegramStatus();
  const settings = useSiteSettings();
  const save = useSetFavoriteAlert();
  const [sides, setSides] = useState<AlertSidesInput>(alert.sides);
  const [minText, setMinText] = useState(alert.minUsd === null ? "" : String(alert.minUsd));

  const minUsd = minText.trim() === "" ? null : Number(minText.replace(/,/g, ""));
  const minInvalid = minUsd !== null && (!Number.isFinite(minUsd) || minUsd < 0);
  const tg = telegram.data;
  const cannotDeliver = tg !== undefined && (!tg.linked || !tg.enabled);

  function submit(enabled: boolean) {
    if (minInvalid) return;
    save.mutate({ address, patch: { enabled, sides, minUsd } }, { onSuccess: onDone });
  }

  const error = save.error;
  const limit =
    error instanceof ApiError && typeof error.details.limit === "number"
      ? error.details.limit
      : settings.data?.maxAlertTraders;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit(true);
      }}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-primary-soft text-primary">
          <BellRing className="size-3.5" />
        </span>
        <h3 className="text-sm font-bold">{t("alerts.title")}</h3>
        {alert.enabled ? (
          <span className="ml-auto rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">
            {t("alerts.enabled")}
          </span>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label>{t("alerts.sides")}</Label>
        <Segmented<AlertSidesInput>
          variant="pill"
          size="sm"
          value={sides}
          onChange={setSides}
          label={t("alerts.sides")}
          className="w-full [&>button]:flex-1"
          options={(["buy", "sell", "both"] as const).map((s) => ({ value: s, label: t(SIDE_KEY[s]) }))}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`alert-min-${address}`}>
          {t("alerts.minUsd")} <span className="font-normal text-subtle-foreground">· {t("common.optional")}</span>
        </Label>
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-sm text-subtle-foreground">$</span>
          <Input
            id={`alert-min-${address}`}
            inputMode="decimal"
            value={minText}
            onChange={(e) => {
              setMinText(e.target.value);
              save.reset();
            }}
            placeholder={t("alerts.minUsdPlaceholder")}
            aria-invalid={minInvalid || undefined}
            className="num pl-7"
          />
        </div>
        {minInvalid ? <p className="text-xs text-negative">{t("alerts.minUsdInvalid")}</p> : null}
      </div>

      {error ? (
        <div role="alert" className="rounded-xl bg-negative-soft px-3 py-2.5 text-xs leading-relaxed text-negative">
          {error.code === "telegram_not_linked" ? (
            <>
              {t("alerts.notLinked")}{" "}
              <Link href="/settings" className="font-semibold underline underline-offset-2" onClick={onDone}>
                {t("alerts.goSettings")}
              </Link>
            </>
          ) : error.code === "alert_limit" ? (
            t("alerts.limit", { limit: limit ?? 3 })
          ) : (
            error.message
          )}
        </div>
      ) : cannotDeliver && !alert.enabled ? (
        <div className="rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
          {t("alerts.notLinked")}{" "}
          <Link href="/settings" className="font-semibold underline underline-offset-2" onClick={onDone}>
            {t("alerts.goSettings")}
          </Link>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {alert.enabled ? (
          <Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={() => submit(false)}>
            {t("common.disable")}
          </Button>
        ) : null}
        <Button type="submit" size="sm" className="ml-auto" disabled={save.isPending || minInvalid}>
          {save.isPending ? t("common.saving") : alert.enabled ? t("common.save") : t("alerts.turnOn")}
        </Button>
      </div>

      {tg?.bot ? (
        <p className="-mt-1 flex items-center gap-1.5 text-[11px] text-subtle-foreground">
          <Send className="size-3" />
          {t("alerts.via", { bot: tg.bot })}
        </p>
      ) : null}
    </form>
  );
}
