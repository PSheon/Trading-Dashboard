"use client";

import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, Delete, Gift, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { PaperBadge } from "@/components/copy/paper-badge";
import { UsdcIcon } from "@/components/wallet/bits";
import { useI18n } from "@/i18n/provider";
import { apiErrorCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCopyOf, useCopyOverview, useStartCopy } from "@/lib/copy";
import { useSiteSettings } from "@/lib/queries";
import { rovingFocus } from "@/lib/roving-focus";

type Direction = "same" | "reverse";

/** CopyDog's Hyperliquid floor (`Minimum ${min} to copy`); the api's policy wins once loaded. */
const DEFAULT_MIN = 100;
const KEYPAD = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["00", "0", "del"]] as const;

/**
 * CopyDog's copy widget for a Hyperliquid trader, in paper mode:
 * 順向 / 反向, the amount in USDC with 最大, 可交易餘額 with its slider, 更多設定
 * (跟單目前持倉, on by default: CopyDog's only extra setting there) and the CTA,
 * whose label follows CopyDog's order: 請輸入金額 → 最低 $100 才能跟單 → 餘額不足
 * → 開始跟單 $X → 已啟動！. The balance is the user's paper account (模擬),
 * never the wallet. CopyDog's other copy fields (sizing mode, amount per
 * trade, max allocation) live in the portfolio's 編輯設定, as on CopyDog.
 *
 * `sheet` is the phone version: the amount is typed on CopyDog's keypad with
 * 25% / 50% / 75% / 最大 presets and a USDC row instead of the slider.
 */
export function CopyPanel({ address, sheet = false }: { address: string; sheet?: boolean }) {
  const { t, format } = useI18n();
  const { status, login } = useAuth();
  const { data: settings } = useSiteSettings();
  const overview = useCopyOverview();
  const existing = useCopyOf(address);
  const start = useStartCopy();
  const [direction, setDirection] = useState<Direction>("same");
  const [amount, setAmount] = useState("");
  const [more, setMore] = useState(false);
  const [copyExisting, setCopyExisting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const startedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(startedTimer.current), []);

  const signedIn = status === "signedIn";
  const balance = overview.data?.paper.balance ?? 0;
  const min = overview.data?.limits.minAllocationUsd ?? DEFAULT_MIN;
  const value = Number.parseFloat(amount);
  const pct = balance > 0 ? Math.min(100, Math.round(((Number.isFinite(value) ? value : 0) / balance) * 100)) : 0;
  const paused = overview.data && (overview.data.platform.pauseNewRisk || overview.data.platform.reduceOnly || overview.data.user.pauseNewRisk || overview.data.user.reduceOnly);

  // CopyDog shrinks the amount to keep "<amount> USDC" on one line.
  const digits = Math.max(1, amount.length);
  const fit = digits <= 4 ? { number: 3.25, unit: 2.25 } : digits <= 5 ? { number: 2.75, unit: 1.9 } : digits <= 7 ? { number: 2.25, unit: 1.6 } : { number: 1.75, unit: 1.25 };

  const label =
    !amount || !(value > 0) ? t("trader.copy.enterAmount") :
    value < min ? t("trader.copy.minToCopy", { min: format.num(min) }) :
    value > balance ? t("trader.copy.notEnoughBalance") :
    t("trader.copy.startCopying", { amount: format.num(value, value % 1 ? 2 : 0) });

  function setFromPct(p: number) {
    setError(null);
    setAmount(balance > 0 ? String(Math.floor((balance * p) / 100)) : "");
  }

  async function submit() {
    setError(null);
    if (!signedIn) {
      login();
      return;
    }
    if (!amount || !(value > 0)) return setError(t("trader.copy.enterAmount"));
    if (value < min) return setError(t("trader.copy.errors.minAllocation", { min: format.num(min) }));
    if (value > balance) return setError(t("trader.copy.errors.exceedsBalance"));
    try {
      await start.mutateAsync({ leader: address, allocationUsd: value, direction, copyStartMode: copyExisting ? "adopt" : "delta" });
      setStarted(true);
      setAmount("");
      startedTimer.current = setTimeout(() => setStarted(false), 2000);
    } catch (err) {
      const code = apiErrorCode(err);
      const limit = overview.data?.limits;
      setError(
        code === "already_copying" ? t("trader.copy.errors.alreadyCopying") :
        code === "insufficient_balance" ? t("trader.copy.errors.exceedsBalance") :
        code === "below_min_allocation" ? t("trader.copy.errors.minAllocation", { min: format.num(min) }) :
        code === "above_max_allocation" ? t("trader.copy.errors.maxAllocation", { max: format.num(limit?.maxAllocationUsd ?? 0) }) :
        code === "copy_paused" ? t("trader.copy.errors.paused") :
        code === "strategy_limit" ? t("trader.copy.errors.limit", { limit: limit?.maxStrategies ?? 0 }) :
        code === "leader_unavailable" ? t("trader.copy.errors.leaderUnavailable") :
        code === "copy_disabled" ? t("trader.copy.errors.disabled") :
        t("trader.copy.errors.failed"),
      );
    }
  }

  const directionPill = (
    <div role="radiogroup" aria-label={t("trader.copy.amount")} className="grid grid-cols-2 gap-1 rounded-full bg-raised p-1">
      {(["same", "reverse"] as const).map((d) => {
        const active = direction === d;
        const Icon = d === "same" ? ArrowUpRight : ArrowDownRight;
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
              active && d === "same" && "bg-primary text-primary-foreground",
              active && d === "reverse" && "bg-negative text-white",
              !active && "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" strokeWidth={2.5} />
            {t(d === "same" ? "trader.copy.follow" : "trader.copy.reverse")}
          </button>
        );
      })}
    </div>
  );

  // Paper-started state: this user already copies the trader.
  if (existing && !started) {
    const pnl = existing.totalPnl;
    return (
      <Shell sheet={sheet}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[0.9375rem] font-bold">{t("trader.copy.copying")}</p>
          <div className="flex items-center gap-1.5">
            {existing.status === "paused" ? <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{t("trader.copy.paused")}</span> : null}
            {existing.status === "stopping" ? <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{t("trader.copy.stopping")}</span> : null}
            <PaperBadge />
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-2 rounded-xl bg-raised/60 p-3 text-center">
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("trader.copy.allocated")}</dt>
            <dd className="num mt-1 text-sm font-bold">{format.usd(existing.allocated, { digits: 2 })}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("trader.copy.pnl")}</dt>
            <dd className={cn("num mt-1 text-sm font-bold", pnl === null ? "" : pnl >= 0 ? "text-positive" : "text-negative")}>
              {pnl === null ? "—" : format.usd(pnl, { sign: true, digits: 2 })}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("trader.copy.positions")}</dt>
            <dd className="num mt-1 text-sm font-bold">{existing.positions.length}</dd>
          </div>
        </dl>
        <Link
          href={`/portfolio?copy=${existing.id}`}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary text-base font-bold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Check className="size-5" strokeWidth={2.5} />
          {t("trader.copy.manage")}
        </Link>
      </Shell>
    );
  }

  return (
    <Shell sheet={sheet}>
      {directionPill}

      <div className={cn("flex items-center gap-3", sheet ? "justify-center py-3" : "py-2")}>
        <label className="sr-only" htmlFor={sheet ? "copy-amount-sheet" : "copy-amount"}>
          {t("trader.copy.amount")}
        </label>
        <div className={cn("flex min-w-0 items-baseline gap-2", !sheet && "flex-1")}>
          <input
            id={sheet ? "copy-amount-sheet" : "copy-amount"}
            inputMode={sheet ? "none" : "decimal"}
            readOnly={sheet}
            placeholder="0"
            value={amount}
            onChange={(e) => {
              setError(null);
              setAmount(e.target.value.replace(/[^\d.]/g, "").slice(0, 12));
            }}
            className="num min-w-0 bg-transparent leading-none font-bold tracking-tight outline-none placeholder:text-foreground"
            style={{ width: `${Math.max(1, (amount || "0").length) + 0.15}ch`, fontSize: `${fit.number}rem` }}
          />
          <span className="leading-none font-bold text-muted-foreground" style={{ fontSize: `${fit.unit}rem` }}>USDC</span>
        </div>
        {!sheet ? (
          <button
            type="button"
            onClick={() => setFromPct(100)}
            disabled={balance <= 0}
            className="h-9 shrink-0 rounded-full bg-raised px-3.5 text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:hover:text-muted-foreground"
          >
            {t("trader.copy.max")}
          </button>
        ) : null}
      </div>

      {sheet ? (
        <>
          <div className="grid grid-cols-4 gap-2">
            {[25, 50, 75, 100].map((p) => {
              const preset = balance > 0 ? String(Math.floor((balance * p) / 100)) : "";
              return (
                <button
                  key={p}
                  type="button"
                  disabled={balance <= 0}
                  onClick={() => setFromPct(p)}
                  className={cn(
                    "h-10 rounded-full text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    preset && amount === preset ? "bg-primary-soft text-primary" : "bg-raised text-foreground",
                  )}
                >
                  {p === 100 ? t("trader.copy.max") : `${p}%`}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2.5 rounded-2xl bg-raised/60 px-3 py-2.5">
            <UsdcIcon size={26} />
            <span className="text-sm font-bold">USDC</span>
            <PaperBadge />
            <span className="ml-auto text-sm">
              <b className="num">{format.num(balance, 2)}</b> <span className="text-muted-foreground">{t("portfolio.copy.paperBalance")}</span>
            </span>
          </div>
          <div role="group" aria-label={t("trader.copy.amount")} className="grid grid-cols-3 gap-1">
            {KEYPAD.flat().map((k) => (
              <button
                key={k}
                type="button"
                aria-label={k === "del" ? "Backspace" : k}
                onClick={() => {
                  setError(null);
                  setAmount((a) => (k === "del" ? a.slice(0, -1) : `${a}${k}`.replace(/^0+(?=\d)/, "").slice(0, 12)));
                }}
                className="flex h-12 items-center justify-center rounded-xl text-xl font-semibold outline-none active:bg-raised focus-visible:ring-2 focus-visible:ring-ring"
              >
                {k === "del" ? <Delete className="size-6" strokeWidth={1.8} /> : k}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2 text-[0.8125rem]">
            <span className="flex items-center gap-2 text-muted-foreground">
              {t("trader.copy.balance")}
              <PaperBadge />
            </span>
            <span className="num font-semibold">{format.num(balance, 2)} USDC</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={pct}
              disabled={balance <= 0}
              onChange={(e) => setFromPct(Number(e.target.value))}
              aria-label={t("trader.copy.balance")}
              className="range-accent flex-1"
              style={{ ["--fill" as string]: `${pct}%` }}
            />
            <span className="num w-10 text-right text-[0.8125rem] font-semibold">{pct}%</span>
          </div>
        </div>
      )}

      <div>
        <button
          type="button"
          aria-expanded={more}
          aria-controls={sheet ? "copy-more-sheet" : "copy-more"}
          onClick={() => setMore((m) => !m)}
          className={cn(
            "flex w-full items-center justify-between rounded-lg py-1 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-ring",
            more ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("trader.copy.more")}
          <ChevronDown className={cn("size-4 transition-transform", more && "rotate-180")} />
        </button>
        {more ? (
          <div id={sheet ? "copy-more-sheet" : "copy-more"} className="mt-3 flex items-center justify-between gap-3">
            <span id="copy-positions" className="text-[0.8125rem] font-semibold" title={t("trader.copy.copyPositionsDesc")}>
              {t("trader.copy.copyPositions")}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={copyExisting}
              aria-labelledby="copy-positions"
              onClick={() => setCopyExisting((v) => !v)}
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                copyExisting ? "bg-primary" : "bg-border-strong",
              )}
            >
              <span className={cn("absolute top-0.5 left-0.5 size-5 rounded-full bg-primary-foreground transition-transform", copyExisting && "translate-x-5")} />
            </button>
          </div>
        ) : null}
      </div>

      {paused ? (
        <p className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {t(overview.data?.platform.pauseNewRisk || overview.data?.platform.reduceOnly ? "trader.copy.platformPaused" : "trader.copy.userPaused")}
        </p>
      ) : null}

      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          onClick={submit}
          disabled={start.isPending || started}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary text-base font-bold text-primary-foreground outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-80"
        >
          {started ? (
            <>
              <Check className="size-5" strokeWidth={2.5} />
              {t("trader.copy.started")}
            </>
          ) : (
            label
          )}
        </button>
        {error ? (
          <p role="alert" className="text-center text-xs font-semibold text-negative">
            {error}
          </p>
        ) : (
          <p className="text-center text-[11px] leading-relaxed text-subtle-foreground">{t("trader.copy.paperHint")}</p>
        )}
      </div>

      {settings?.referralCode ? (
        <p className="flex items-start gap-2 rounded-xl bg-raised px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <Gift className="mt-px size-3.5 shrink-0 text-primary" />
          <span>{t("trader.copy.referral", { code: settings.referralCode })}</span>
        </p>
      ) : null}
    </Shell>
  );
}

function Shell({ sheet, children }: { sheet: boolean; children: React.ReactNode }) {
  return sheet ? (
    <div className="flex flex-col gap-4 px-1 pt-9">{children}</div>
  ) : (
    <aside className="flex flex-col gap-6 rounded-2xl border border-border bg-card p-4 md:p-5 xl:sticky xl:top-[92px]">{children}</aside>
  );
}
