"use client"

import { rovingFocus } from "@/lib/roving-focus";

import { ArrowDownRight, ArrowUpRight, ChevronDown, Gift } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { useI18n } from "@/i18n/provider";
import { useSiteSettings } from "@/lib/queries";

type Direction = "follow" | "reverse";

/**
 * Copy panel (UI only in Stage 2 — nothing is signed or sent). The CTA
 * follows the admin's `copyTradingEnabled` switch for its look, but always
 * reads "coming soon" and does nothing.
 */
export function CopyPanel() {
  const { t, format } = useI18n();
  const { data: settings } = useSiteSettings();
  const [direction, setDirection] = useState<Direction>("follow");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState(0);
  const [more, setMore] = useState(false);
  const balance = 0;
  const enabled = settings?.copyTradingEnabled ?? false;

  return (
    <aside className="flex flex-col gap-6 rounded-2xl border border-border bg-card p-4 md:p-5 xl:sticky xl:top-[92px]">
      <div role="radiogroup" aria-label={t("trader.copy.amount")} className="grid grid-cols-2 gap-1 rounded-full bg-raised p-1">
        {(["follow", "reverse"] as const).map((d) => {
          const active = direction === d;
          const Icon = d === "follow" ? ArrowUpRight : ArrowDownRight;
          return (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={rovingFocus}
              onClick={() => setDirection(d)}
              className={cn(
                "flex h-12 items-center justify-center gap-1.5 rounded-full text-[0.9375rem] font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" strokeWidth={2.5} />
              {t(`trader.copy.${d}`)}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 py-2">
        <label className="sr-only" htmlFor="copy-amount">
          {t("trader.copy.amount")}
        </label>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <input
            id="copy-amount"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, "").slice(0, 10))}
            className="num w-full min-w-0 bg-transparent text-[3.25rem] leading-none font-bold tracking-tight outline-none placeholder:text-foreground"
            style={{ width: `${Math.max(1, (amount || "0").length) + 0.4}ch` }}
          />
          <span className="text-[2.25rem] leading-none font-bold text-muted-foreground">USDC</span>
        </div>
        <button
          type="button"
          onClick={() => {
            setAmount(String(balance));
            setPercent(100);
          }}
          className="h-9 shrink-0 rounded-full bg-raised px-3.5 text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("trader.copy.max")}
        </button>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between text-[0.8125rem]">
          <span className="text-muted-foreground">{t("trader.copy.balance")}</span>
          <span className="num font-semibold">{format.num(balance, 2)} USDC</span>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            onChange={(e) => setPercent(Number(e.target.value))}
            aria-label={t("trader.copy.balance")}
            className="range-accent flex-1"
            style={{ ["--fill" as string]: `${percent}%` }}
          />
          <span className="num w-10 text-right text-[0.8125rem] font-semibold">{percent}%</span>
        </div>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
          className="flex w-full items-center justify-between rounded-lg py-1 text-[0.8125rem] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("trader.copy.more")}
          <ChevronDown className={cn("size-4 transition-transform", more && "rotate-180")} />
        </button>
        {more ? (
          <div className="mt-3 grid gap-2.5">
            {(["leverage", "stopLoss", "takeProfit"] as const).map((field) => (
              <label key={field} className="flex items-center justify-between gap-3 text-[0.8125rem]">
                <span className="text-muted-foreground">{t(`trader.copy.${field}`)}</span>
                <input
                  disabled
                  placeholder="—"
                  className="h-9 w-28 rounded-xl border border-border bg-raised px-3 text-right text-sm disabled:opacity-60"
                />
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          aria-disabled
          disabled={!enabled}
          onClick={(e) => e.preventDefault()}
          className={cn(
            "h-14 w-full rounded-full text-base font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
            enabled
              ? "cursor-not-allowed bg-primary text-primary-foreground"
              : "cursor-not-allowed bg-primary/35 text-primary-foreground/70",
          )}
        >
          {t("trader.copy.cta")}
        </button>
        <p className="text-center text-[11px] leading-relaxed text-subtle-foreground">{t("trader.copy.hint")}</p>
      </div>

      {settings?.referralCode ? (
        <p className="flex items-start gap-2 rounded-xl bg-raised px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <Gift className="mt-px size-3.5 shrink-0 text-primary" />
          <span>{t("trader.copy.referral", { code: settings.referralCode })}</span>
        </p>
      ) : null}
    </aside>
  );
}
