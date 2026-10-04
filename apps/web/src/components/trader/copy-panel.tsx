"use client";

import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, Delete, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "cn";

import { PaperBadge } from "@/components/copy/paper-badge";
import { HedgeNotice } from "@/components/copy/portfolio-parts";
import { useToast } from "@/components/ui/toast";
import { UsdcIcon } from "@/components/wallet/bits";
import { useI18n } from "@/i18n/provider";
import { apiErrorCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCopyOf, useCopyOverview, useStartCopy } from "@/lib/copy";
import { useSiteSettings } from "@/lib/queries";
import { amountInput } from "@/lib/amount-input";
import { hedgeWarning } from "@/lib/copy-portfolio";
import { coinLabel, truncateAddress } from "@/lib/format";
import { rovingFocus } from "@/lib/roving-focus";

type Direction = "same" | "reverse";

/** CopyDog's Hyperliquid floor (`Minimum ${min} to copy`); the api's policy wins once loaded. */
const DEFAULT_MIN = 100;
const KEYPAD = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["00", "0", "del"]] as const;
/** CopyDog's amount type: 64px, shrinking to 28px as the amount grows. */
const AMOUNT_MAX_PX = 64;
const AMOUNT_MIN_PX = 28;
let measureContext: CanvasRenderingContext2D | null = null;

/**
 * CopyDog's copy widget for a Hyperliquid trader, in paper mode:
 * 順向 / 反向, the amount in USDC with 最大, 可交易餘額 with its slider, 更多設定
 * (跟單目前持倉, on by default: CopyDog's only extra setting there) and the CTA,
 * whose label follows CopyDog's order: 請輸入金額 → 最低 $100 才能跟單 → 餘額不足
 * → 開始跟單 $X → 已啟動！. Submitting with a bad amount or a failed start
 * raises CopyDog's toast (the panel itself shows no error text). The
 * balance is the user's paper account (模擬), never the wallet. CopyDog's other copy fields (sizing mode, amount per
 * trade, max allocation) live in the portfolio's 編輯設定, as on CopyDog.
 *
 * While the admin's copy-trading switch is off (`copyTradingEnabled` in the
 * public settings) no new copy can start: the CTA is disabled and says so;
 * a copy this user already runs shows as usual.
 *
 * `sheet` is the phone version: the amount is typed on CopyDog's keypad with
 * 25% / 50% / 75% / 最大 presets and a USDC row instead of the slider.
 */
export function CopyPanel({ address, sheet = false, leaderPositions, traderName }: { address: string; sheet?: boolean; leaderPositions?: ReadonlyArray<{ coin: string; szi: number }>; traderName?: string }) {
  const { t, format } = useI18n();
  const toast = useToast();
  const { status, login } = useAuth();
  const overview = useCopyOverview();
  const existing = useCopyOf(address);
  const start = useStartCopy();
  // Only a loaded "off" closes the panel; the api refuses in any case.
  const closed = useSiteSettings().data?.copyTradingEnabled === false;
  const [direction, setDirection] = useState<Direction>("same");
  const [amount, setAmount] = useState("");
  const [more, setMore] = useState(false);
  const [copyExisting, setCopyExisting] = useState(true);
  const [started, setStarted] = useState(false);
  // CopyDog's hedge_warning: shown once a copy starts, until dismissed.
  const [hedge, setHedge] = useState<{ coins: string[] } | null>(null);
  const startedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(startedTimer.current), []);

  const signedIn = status === "signedIn";
  // A signed-in user's balance is unknown until /me/copy has answered (and
  // stays unknown if it failed): the panel then shows "—", not 0.00, and
  // does not judge or clamp what was typed against a balance of zero.
  const balanceKnown = !signedIn || overview.data !== undefined;
  const balance = overview.data?.paper.balance ?? 0;
  const balanceText = balanceKnown ? balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const min = overview.data?.limits.minAllocationUsd ?? DEFAULT_MIN;
  const value = Number.parseFloat(amount);
  const pct = balance > 0 ? Math.min(100, Math.round(((Number.isFinite(value) ? value : 0) / balance) * 100)) : 0;
  const paused = overview.data && (overview.data.platform.pauseNewRisk || overview.data.platform.reduceOnly || overview.data.user.pauseNewRisk || overview.data.user.reduceOnly);

  // CopyDog shrinks the amount to keep "<amount> USDC" on one line.
  const digits = Math.max(1, amount.length);
  const fit = digits <= 4 ? { number: 3.25, unit: 2.25 } : digits <= 5 ? { number: 2.75, unit: 1.9 } : digits <= 7 ? { number: 2.25, unit: 1.6 } : { number: 1.75, unit: 1.25 };
  // Desktop: CopyDog's own fit, 64px down to 28px so that the amount, its
  // unit and 最大 share the row.
  const fieldRef = useRef<HTMLDivElement>(null);
  const [amountPx, setAmountPx] = useState(AMOUNT_MAX_PX);
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const measure = () => {
      const input = field.querySelector<HTMLInputElement>("input");
      const max = field.querySelector<HTMLButtonElement>("button");
      if (!input) return;
      const gap = Number.parseFloat(getComputedStyle(field).columnGap) || 0;
      const room = field.clientWidth - ((max ? max.offsetWidth + gap : 0) + gap);
      if (room <= 0) return;
      measureContext ??= document.createElement("canvas").getContext("2d");
      if (!measureContext) return;
      measureContext.font = `700 ${AMOUNT_MAX_PX}px ${getComputedStyle(input).fontFamily}`;
      const width = measureContext.measureText(`${amount || "0"}USDC`).width;
      setAmountPx(Math.max(AMOUNT_MIN_PX, Math.min(AMOUNT_MAX_PX, Math.floor((AMOUNT_MAX_PX * (room * 0.98)) / Math.max(width, 1)))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    void document.fonts?.ready?.then(measure);
    return () => observer.disconnect();
  }, [amount]);

  const label =
    closed ? t("trader.copy.errors.disabled") :
    !amount || !(value > 0) ? t("trader.copy.enterAmount") :
    value < min ? t("trader.copy.minToCopy", { min: format.num(min) }) :
    balanceKnown && value > balance ? t("trader.copy.notEnoughBalance") :
    t("trader.copy.startCopying", { amount: format.num(value, value % 1 ? 2 : 0) });

  function setFromPct(p: number) {
    setAmount(balance > 0 ? String(Math.floor((balance * p) / 100)) : "");
  }

  async function submit() {
    if (!signedIn) {
      login();
      return;
    }
    if (closed) return toast.error(t("trader.copy.errors.disabled"));
    if (!amount || !(value > 0)) return toast.error(t("trader.copy.enterAmount"));
    if (value < min) return toast.error(t("trader.copy.errors.minAllocation", { min: format.num(min) }));
    if (!balanceKnown) {
      // The balance never loaded: ask again rather than start blind.
      void overview.refetch?.();
      return toast.error(t("trader.copy.errors.failed"));
    }
    if (value > balance) return toast.error(t("trader.copy.errors.exceedsBalance"));
    try {
      const others = overview.data?.strategies ?? [];
      const created = await start.mutateAsync({ leader: address, allocationUsd: value, direction, copyStartMode: copyExisting ? "adopt" : "delta" });
      setHedge(hedgeWarning(leaderPositions ?? [], direction, others, address));
      // 跟單目前持倉: say which of the trader's positions were left out (a
      // market that is not copied, a position too small, a cap).
      const adoption = created.adoption ?? [];
      const skipped = adoption.filter((a) => !a.adopted);
      if (skipped.length > 0) {
        toast.info(t("trader.copy.errors.adoptionPartial", { adopted: adoption.length - skipped.length, total: adoption.length, coins: skipped.map((a) => coinLabel(a.coin)).join(", ") }));
      }
      setStarted(true);
      setAmount("");
      startedTimer.current = setTimeout(() => setStarted(false), 2000);
    } catch (err) {
      const code = apiErrorCode(err);
      const limit = overview.data?.limits;
      // CopyDog: "already copying" is an info toast, the rest are errors.
      if (code === "already_copying") return toast.info(t("trader.copy.errors.alreadyCopying"));
      toast.error(
        code === "insufficient_balance" ? t("trader.copy.errors.exceedsBalance") :
        code === "below_min_allocation" ? t("trader.copy.errors.minAllocation", { min: format.num(min) }) :
        code === "above_max_allocation" ? t("trader.copy.errors.maxAllocation", { max: format.num(limit?.maxAllocationUsd ?? 0) }) :
        code === "copy_paused" ? t("trader.copy.errors.paused") :
        code === "strategy_limit" ? t("trader.copy.errors.limit", { limit: limit?.maxStrategies ?? 0 }) :
        code === "leader_unavailable" ? t("trader.copy.errors.leaderUnavailable") :
        code === "copy_disabled" || code === "copy_not_open" ? t("trader.copy.errors.disabled") :
        t("trader.copy.errors.failed"),
      );
    }
  }

  const directionPill = (
    <div role="radiogroup" aria-label={t("trader.copy.amount")} className="grid grid-cols-2 gap-0.5 rounded-full bg-inset p-1">
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
              "flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-base leading-6 font-extrabold outline-none transition-[color,background-color,opacity] duration-200 focus-visible:ring-2 focus-visible:ring-ring",
              active && d === "same" && "bg-primary text-primary-foreground",
              // Dark on the red, as on the orange: white on it is 3.4:1.
              active && d === "reverse" && "bg-negative text-primary-foreground",
              !active && "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" strokeWidth={2} />
            {t(d === "same" ? "trader.copy.follow" : "trader.copy.reverse")}
          </button>
        );
      })}
    </div>
  );

  const hedgeNotice = hedge ? <HedgeNotice trader={traderName || truncateAddress(address)} coins={hedge.coins} onDismiss={() => setHedge(null)} /> : null;

  // Paper-started state: this user already copies the trader.
  if (existing && !started) {
    const pnl = existing.totalPnl;
    return (
      <Shell sheet={sheet}>
        {hedgeNotice}
        <div className="flex items-center justify-between gap-2">
          <p className="text-[0.9375rem] font-bold">{t("trader.copy.copying")}</p>
          <div className="flex items-center gap-1.5">
            {existing.status === "paused" ? <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{t("trader.copy.paused")}</span> : null}
            {existing.status === "stopping" ? <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{t("trader.copy.stopping")}</span> : null}
            <PaperBadge />
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-2 rounded-xl bg-inset p-3 text-center">
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
          className="orbit-press flex h-[60px] w-full items-center justify-center gap-2 rounded-full bg-primary font-display text-lg text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Check className="size-5" strokeWidth={2.5} />
          {t("trader.copy.manage")}
        </Link>
      </Shell>
    );
  }

  return (
    <Shell sheet={sheet}>
      {hedgeNotice}
      {directionPill}

      {sheet ? (
        <div className="flex items-center justify-center gap-3 py-3">
          <label className="sr-only" htmlFor="copy-amount-sheet">
            {t("trader.copy.amount")}
          </label>
          <div className="flex min-w-0 items-baseline gap-2">
            <input
              id="copy-amount-sheet"
              inputMode="none"
              readOnly
              placeholder="0"
              value={amount}
              className="num min-w-0 bg-transparent leading-none font-bold outline-none placeholder:text-foreground"
              style={{ width: `${Math.max(1, (amount || "0").length) + 0.15}ch`, fontSize: `${fit.number}rem` }}
            />
            <span className="leading-none font-bold text-muted-foreground" style={{ fontSize: `${fit.unit}rem` }}>USDC</span>
          </div>
        </div>
      ) : (
        <div ref={fieldRef} className="flex min-w-0 items-baseline gap-2.5 pt-10">
          <label className="sr-only" htmlFor="copy-amount">
            {t("trader.copy.amount")}
          </label>
          <input
            id="copy-amount"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => {
              setAmount(amountInput(e.target.value, amount).slice(0, 12));
            }}
            onBlur={() => {
              // CopyDog clamps to the whole-dollar balance when focus leaves.
              if (amount && Number.isFinite(value) && balanceKnown) setAmount(String(Math.min(Math.floor(value), Math.floor(balance))));
            }}
            className="num min-w-[1ch] bg-transparent p-0 font-display leading-none outline-none placeholder:text-foreground"
            style={{ width: `${Math.max(1, (amount || "0").length)}ch`, fontSize: amountPx, height: Math.round(amountPx * 1.328) }}
          />
          <span className="shrink-0 font-display leading-none text-muted-foreground" style={{ fontSize: amountPx }}>USDC</span>
          <button
            type="button"
            onClick={() => setFromPct(100)}
            disabled={balance <= 0}
            className="orbit-press ml-auto shrink-0 self-center rounded-full bg-inset px-4 py-2.5 text-[13px] leading-5 font-extrabold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("trader.copy.max")}
          </button>
        </div>
      )}

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
                    preset && amount === preset ? "bg-tag-alert text-tag-alert-foreground" : "bg-raised text-foreground",
                  )}
                >
                  {p === 100 ? t("trader.copy.max") : `${p}%`}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2.5 rounded-xl bg-inset px-3.5 py-3">
            <UsdcIcon size={26} />
            <span className="text-sm font-bold">USDC</span>
            <PaperBadge />
            <span className="ml-auto text-sm">
              <b className="num">{balanceKnown ? format.num(balance, 2) : "—"}</b> <span className="text-muted-foreground">{t("portfolio.copy.paperBalance")}</span>
            </span>
          </div>
          <div role="group" aria-label={t("trader.copy.amount")} className="grid grid-cols-3 gap-1">
            {KEYPAD.flat().map((k) => (
              <button
                key={k}
                type="button"
                aria-label={k === "del" ? "Backspace" : k}
                onClick={() => {
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
        <div>
          <div className="mt-10 flex items-center justify-between gap-3 text-sm leading-[21px]">
            <span className="flex items-center gap-2 text-muted-foreground">
              {t("trader.copy.balance")}
              <PaperBadge />
            </span>
            <span className="num font-semibold">{balanceText} USDC</span>
          </div>
          <div className="mt-4 flex items-center gap-3">
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
            <span className="num min-w-[3.5ch] shrink-0 text-right text-sm leading-[21px] font-bold">{pct}%</span>
          </div>
        </div>
      )}

      <div className={sheet ? undefined : "mt-7"}>
        <button
          type="button"
          aria-expanded={more}
          aria-controls={sheet ? "copy-more-sheet" : "copy-more"}
          onClick={() => setMore((m) => !m)}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded border-t-2 border-dotted border-border pt-2 text-sm leading-5 font-extrabold text-foreground outline-none hover:text-primary-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("trader.copy.more")}
          <ChevronDown className={cn("size-3 transition-transform", more && "rotate-180")} />
        </button>
        {more ? (
          <div id={sheet ? "copy-more-sheet" : "copy-more"} className="mt-3 flex items-center justify-between gap-3">
            <span id="copy-positions" className="text-[13px] font-semibold" title={t("trader.copy.copyPositionsDesc")}>
              {t("trader.copy.copyPositions")}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={copyExisting}
              aria-labelledby="copy-positions"
              onClick={() => setCopyExisting((v) => !v)}
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                copyExisting ? "bg-primary" : "bg-border-strong",
              )}
            >
              <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-primary-foreground shadow-xs transition-transform", copyExisting && "translate-x-4")} />
            </button>
          </div>
        ) : null}
      </div>

      {paused ? (
        <p className={cn("flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning", !sheet && "mt-7")}>
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {t(overview.data?.platform.pauseNewRisk || overview.data?.platform.reduceOnly ? "trader.copy.platformPaused" : "trader.copy.userPaused")}
        </p>
      ) : null}

      <div className={cn("flex flex-col gap-2.5", !sheet && "pt-7")}>
        <button
          type="button"
          onClick={submit}
          disabled={start.isPending || started || closed}
          className="orbit-press flex min-h-[60px] w-full items-center justify-center gap-2 rounded-full bg-primary px-6 font-display text-lg text-primary-foreground outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-80"
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
      </div>
    </Shell>
  );
}

function Shell({ sheet, children }: { sheet: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  return sheet ? (
    <div className="flex flex-col gap-4 px-1 pt-9">{children}</div>
  ) : (
    <aside aria-label={t("trader.copy.panel")} className="orbit-card flex flex-col p-5 xl:sticky xl:top-[92px]">{children}</aside>
  );
}
