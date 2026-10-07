"use client";

import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, Delete, TriangleAlert } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "cn";

import { LiveCopyConfirm, LiveCopyProgress, liveSetupError, useCopyTexts, useLiveSetupText } from "@/components/copy/live-copy-setup-dialogs";
import { LiveSettingsFields } from "@/components/copy/live-copy-settings-fields";
import { Button } from "@/components/ui/button";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { HedgeNotice } from "@/components/copy/portfolio-parts";
import { useTradingMode, type SiteMode } from "@/lib/site-mode";
import { useToast } from "@/components/ui/toast";
import { usePendingToast } from "@/lib/use-action-toast";
import { UsdcIcon } from "@/components/wallet/bits";
import { useI18n } from "@/i18n/provider";
import { liveCopiesMessages } from "@/i18n/live-copies";
import { apiErrorCode } from "@/lib/api";
import { copyErrorText } from "@/lib/copy-error-text";
import { useAuth } from "@/lib/auth";
import { useCopyOf, useCopyOverview, useStartCopy } from "@/lib/copy";
import { liveSetupScope, useLiveCopyDeployment, useLiveCopySetupActions } from "@/lib/copy-live-setup";
import { useLiveCopyPortfolio } from "@/lib/copy-live-portfolio";
import { useWallet } from "@/lib/wallet";
import type { CopyStrategySettings, LiveCopySetup } from "@trading-dashboard/shared/contracts";
import { useSiteSettings } from "@/lib/queries";
import { amountInput } from "@/lib/amount-input";
import { hedgeWarning } from "@/lib/copy-portfolio";
import { coinLabel, truncateAddress } from "@/lib/format";
import { rovingFocus } from "@/lib/roving-focus";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";

type Direction = "same" | "reverse";
/**
 * The testnet setup this panel is confirming or following, per signed-in
 * person and trader (`<identity>#<session>:<leader>`), for the page's life:
 * the panel can remount while a dialog is open (the trader page redraws its
 * layout), and neither the confirm sheet nor the progress dialog may vanish
 * with it. Another session (signing out, switching accounts in the tab)
 * never sees them: they are dropped when it changes.
 */
interface PanelSetup { setup: LiveCopySetup | null; confirmOpen: boolean; progressId: string | null; starting?: boolean }
const EMPTY_SETUP: PanelSetup = { setup: null, confirmOpen: false, progressId: null };
const panelSetups = new Map<string, PanelSetup>();
let panelSetupScope: string | null = null;
const panelSetupListeners = new Set<() => void>();
export function usePanelSetup(identity: string | null, leader: string, mode: SiteMode = "paper"): [PanelSetup, (change: Partial<PanelSetup>) => void] {
  const scope = liveSetupScope(identity), key = `${scope}:${leader}:${mode}`;
  const value = useSyncExternalStore((listener) => { panelSetupListeners.add(listener); return () => panelSetupListeners.delete(listener); },
    () => (scope && scope === panelSetupScope ? panelSetups.get(key) : undefined) ?? EMPTY_SETUP, () => EMPTY_SETUP);
  return [value, (change) => {
    if (!scope) return;
    if (scope !== panelSetupScope) { panelSetups.clear(); panelSetupScope = scope; }
    panelSetups.set(key, { ...(panelSetups.get(key) ?? EMPTY_SETUP), ...change });
    panelSetupListeners.forEach((listener) => listener());
  }];
}

/** CopyDog's Hyperliquid floor (`Minimum ${min} to copy`); the api's policy wins once loaded. */
const DEFAULT_MIN = 100;
const KEYPAD = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["00", "0", "del"]] as const;
/** CopyDog's amount type: 64px, shrinking to 28px as the amount grows. */
const AMOUNT_MAX_PX = 64;
const AMOUNT_MIN_PX = 28;
/** The amount box keeps the height of 64 px text whatever the digits
 * (Paul, 2026-10-07: the card shrank from 85 to 37 px while typing); only
 * the figure's size changes. The USDC suffix stays 18 px. */
export const AMOUNT_ROW_PX = Math.round(AMOUNT_MAX_PX * 1.328);
const AMOUNT_UNIT_PX = 18;
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
export function CopyPanel(props: React.ComponentProps<typeof CopyPanelForm>) {
  const { mode } = useTradingMode();
  return <CopyPanelForm key={mode} {...props} />;
}

function CopyPanelForm({ address, sheet = false, leaderPositions, traderName }: { address: string; sheet?: boolean; leaderPositions?: ReadonlyArray<{ coin: string; szi: number }>; traderName?: string }) {
  const { t, format, locale } = useI18n();
  const toast = useToast(), pending = usePendingToast();
  const { status, login, identity } = useAuth();
  const overview = useCopyOverview();
  const existing = useCopyOf(address);
  const start = useStartCopy();
  const liveText = useLiveSetupText(), copyTexts = useCopyTexts();
  const deployment = useLiveCopyDeployment();
  const trading = useTradingMode();
  // A live deployment: a fixed amount per trade only, within its bounds.
  const fixedOnly = deployment?.caps?.fixedPerTradeUsd ?? null, leverageCap = deployment?.caps?.maxLeverage ?? null;
  // A testnet deployment may copy a testnet leader (`?network=testnet`, read
  // at start); trader pages are mainnet leaders.
  const leaderNetwork = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("network") === "testnet"
    && deployment?.sourceNetworks.includes("testnet") ? "testnet" as const : "mainnet" as const;
  const mode = trading.mode;
  const testnet = mode !== "paper";
  const wallet = useWallet();
  const live = useLiveCopySetupActions();
  const liveCopies = useLiveCopyPortfolio();
  const liveExisting = liveCopies.data?.items.find((item) => item.leaderAddress === address.toLowerCase() && item.status !== "stopped" && item.network === (mode === "live" ? "mainnet" : "testnet")) ?? null;
  const [{ setup, confirmOpen, progressId, starting = false }, updateSetup] = usePanelSetup(identity, address.toLowerCase(), mode);
  // A start prepares the copy wallet, its agent and the deposit (10-20 s on
  // Privy): pending for the whole request, also across a remount (the
  // panel store), and the confirm sheet opens whenever it answers.
  const preparing = starting || live.start.isPending;
  const setSetup = (next: LiveCopySetup | null) => updateSetup({ setup: next });
  const setConfirmOpen = (open: boolean) => updateSetup({ confirmOpen: open });
  const setProgressId = (id: string | null) => updateSetup({ progressId: id });
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [sizing, setSizing] = useState<"ratio" | "fixed">("ratio");
  const [perTrade, setPerTrade] = useState("");
  const [maxExposure, setMaxExposure] = useState("");
  const [maxLeverage, setMaxLeverage] = useState("");
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
  // Actual (正式 / 測試網): the main wallet's withdrawable on the deployment's network (what the
  // deposit UsdSend can move), never the paper balance.
  const testnetBalance = trading.available && deployment && wallet.data?.network === deployment.network ? wallet.data.hyperliquid?.withdrawable ?? null : null;
  const balanceKnown = !signedIn || (testnet ? testnetBalance !== null : overview.data !== undefined);
  const balance = (testnet ? testnetBalance : overview.data?.paper.balance) ?? 0;
  const balanceText = balanceKnown ? balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  // 正式 / 測試網: the deployment's caps (its per-trade minimum, else 1, and
  // its largest budget); the paper limits apply to 模擬 only.
  const { min, max } = copyAmountBounds(testnet, overview.data?.limits, deployment?.caps);
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
      const style = getComputedStyle(field);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      measureContext ??= document.createElement("canvas").getContext("2d");
      if (!measureContext) return;
      measureContext.font = `700 ${AMOUNT_UNIT_PX}px ${getComputedStyle(input).fontFamily}`;
      const unit = measureContext.measureText("USDC").width;
      const room = field.clientWidth - padding - (max ? max.offsetWidth + gap : 0) - unit - gap;
      if (room <= 0) return;
      measureContext.font = `700 ${AMOUNT_MAX_PX}px ${getComputedStyle(input).fontFamily}`;
      const width = measureContext.measureText(amount || "0").width;
      setAmountPx(Math.max(AMOUNT_MIN_PX, Math.min(AMOUNT_MAX_PX, Math.floor((AMOUNT_MAX_PX * (room * 0.98)) / Math.max(width, 1)))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    void document.fonts?.ready?.then(measure);
    return () => observer.disconnect();
  }, [amount]);

  // Nothing to copy with: a signed-in user with a known zero balance gets a
  // locked amount and button; a visitor gets a locked amount and a button
  // that signs in.
  const empty = signedIn && balanceKnown && balance <= 0;
  const amountLocked = empty || !signedIn;
  // 正式 with an empty main wallet: the way on is 儲值, not a dead
  // 「餘額不足」 (Stage A3). Paper money cannot be deposited.
  const fundFirst = testnet && empty;
  const { openDeposit } = useWalletModals();

  const label =
    !trading.available ? t("mode.unavailable") :
    closed ? t("trader.copy.errors.disabled") :
    !signedIn ? t("common.signIn") :
    fundFirst ? t("portfolio.deposit") :
    empty ? t("trader.copy.notEnoughBalance") :
    !amount || !(value > 0) ? t("trader.copy.enterAmount") :
    value < min ? t("trader.copy.minToCopy", { min: format.num(min) }) :
    max !== null && value > max ? t("trader.copy.maxToCopy", { max: format.num(max) }) :
    balanceKnown && value > balance ? t("trader.copy.notEnoughBalance") :
    t("trader.copy.startCopying", { amount: format.num(value, value % 1 ? 2 : 0) });

  /** A share of the balance, never above the deployment's cap. */
  const presetOf = (p: number) => balance > 0 ? String(Math.floor(Math.min((balance * p) / 100, max ?? Number.POSITIVE_INFINITY))) : "";
  function setFromPct(p: number) {
    setAmount(presetOf(p));
  }

  async function submit() {
    if (!signedIn) {
      login();
      return;
    }
    if (!trading.available) return toast.error(t("mode.unavailable"));
    if (closed) return toast.error(t("trader.copy.errors.disabled"));
    if (fundFirst) return openDeposit();
    if (!amount || !(value > 0)) return toast.error(t("trader.copy.enterAmount"));
    if (value < min) return toast.error(t("trader.copy.errors.minAllocation", { min: format.num(min) }));
    if (max !== null && value > max) return toast.error(t("trader.copy.errors.maxAllocation", { max: format.num(max) }));
    if (!balanceKnown) {
      // The balance never loaded: ask again rather than start blind.
      void overview.refetch?.();
      return toast.error(t("trader.copy.errors.failed"));
    }
    if (value > balance) return toast.error(t("trader.copy.errors.exceedsBalance"));
    if (testnet) return startTestnet();
    try {
      const others = overview.data?.strategies ?? [];
      const created = await pending(start.mutateAsync({ leader: address, allocationUsd: value, direction, copyStartMode: copyExisting ? "adopt" : "delta" }), t("toast.copy.starting"));
      toast.success(t("toast.copy.started"));
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

  async function startTestnet() {
    const sizingMode = fixedOnly ? "fixed" : sizing;
    const fixed = sizingMode === "fixed" ? Number.parseFloat(perTrade) : null;
    if (sizingMode === "fixed" && !(fixed && fixed > 0)) return toast.error(t("trader.copy.enterAmount"));
    if (fixedOnly && fixed !== null && (fixed < fixedOnly.min || fixed > fixedOnly.max)) return toast.error(`${liveText.perTrade}: ${fixedOnly.min}–${fixedOnly.max}`);
    const exposure = maxExposure ? Number.parseFloat(maxExposure) : null, leverage = maxLeverage ? Number.parseFloat(maxLeverage) : null;
    const settings: CopyStrategySettings = { direction, sizingMode, perTradeUsd: fixed, maxTotalExposureUsd: exposure && exposure > 0 ? exposure : null,
      maxLeverage: leverage && leverage >= 1 ? Math.min(50, leverage) : null, copyStartMode: "delta" };
    updateSetup({ starting: true });
    try {
      const prepared = await pending(live.start.mutateAsync({ leader: address.toLowerCase(), budgetUsd: String(Math.floor(value * 1e6) / 1e6), settings, sourceNetwork: leaderNetwork() }), t("toast.copy.starting"));
      if (prepared.stage === "awaiting_consent" && prepared.consent) { setConfirmError(null); updateSetup({ setup: prepared, confirmOpen: true, starting: false }); return; }
      updateSetup({ setup: prepared, starting: false });
      // Still preparing (its wallet or agent is slow), or already confirmed
      // earlier (a retried start): the progress dialog shows where it stands,
      // and offers 重新開始 / 取消設定 while it is still preparing.
      setProgressId(prepared.id);
    } catch (err) { updateSetup({ starting: false }); liveError(err); }
  }
  async function confirmTestnet() {
    if (!setup) return;
    setConfirmError(null);
    try {
      const confirmed = await live.confirm.mutateAsync(setup);
      setConfirmOpen(false); setAmount(""); setProgressId(confirmed.id);
      // The progress dialog takes over; the toast says it is under way.
      toast.info(t("toast.copy.starting"));
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === "consent_expired") {
        // A fresh challenge for the same attempt; the owner confirms again.
        try { const again = await live.start.mutateAsync({ leader: setup.leaderAddress, budgetUsd: setup.budgetUsd, settings: setup.settings, sourceNetwork: setup.sourceNetwork }); setSetup(again); } catch { /* shown below */ }
      }
      setConfirmError(copyErrorText(copyTexts, err));
      toast.error(copyErrorText(copyTexts, err));
    }
  }
  function liveError(err: unknown) {
    const code = apiErrorCode(err), limit = overview.data?.limits;
    if (code === "already_copying") return toast.info(t("trader.copy.errors.alreadyCopying"));
    toast.error(
      code === "below_min_allocation" ? t("trader.copy.errors.minAllocation", { min: format.num(min) }) :
      code === "above_max_allocation" ? t("trader.copy.errors.maxAllocation", { max: format.num(max ?? limit?.maxAllocationUsd ?? 0) }) :
      code === "copy_paused" ? t("trader.copy.errors.paused") :
      code === "copy_not_open" ? t("trader.copy.errors.disabled") :
      copyErrorText(copyTexts, err),
    );
  }

  /** A setup waiting for its consent: back to the confirm sheet. */
  function reviewSetup(next: LiveCopySetup) {
    setSetup(next);
    if (next.stage === "awaiting_consent" && next.consent) { setConfirmError(null); updateSetup({ setup: next, confirmOpen: true, progressId: null }); }
    else setProgressId(next.id);
  }
  /** The same terms again (a fresh consent); the server ends the old setup. */
  async function restartTestnet(from: LiveCopySetup | string) {
    try { reviewSetup(await live.restart.mutateAsync(from)); toast.success(t("toast.copy.setupRestarted")); } catch (err) { liveError(err); }
  }
  async function cancelTestnet(id: string) {
    try { await live.cancel.mutateAsync(id); updateSetup({ setup: null, confirmOpen: false, progressId: null }); toast.success(t("toast.copy.setupCancelled")); } catch (err) { liveError(err); }
  }

  const liveDialogs = (
    <>
      <LiveCopyConfirm setup={setup} traderName={traderName} open={confirmOpen} onOpenChange={(open) => { if (!live.confirm.isPending) setConfirmOpen(open); }}
        onConfirm={() => void confirmTestnet()} pending={live.confirm.isPending || live.start.isPending || live.restart.isPending} error={confirmError}
        note={live.confirmPhase === "attaching" ? liveText.attachingSigner : null} />
      <LiveCopyProgress setupId={progressId} open={progressId !== null} onOpenChange={(open) => { if (!open) setProgressId(null); }}
        onConsent={reviewSetup} onRetry={(ended) => void restartTestnet(ended)} />
    </>
  );

  const directionPill = (
    <div role="radiogroup" aria-label={t("trader.copy.direction")} className="grid grid-cols-2 gap-0.5 rounded-full bg-inset p-1">
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

  // A testnet start of this trader that ended without copying (failed,
  // expired) or whose consent lapsed: not 跟單中, but 重新開始 / 取消設定.
  const endedSetup = liveExisting?.setup && liveExisting.setup.kind === "start" &&
    (["failed", "expired"].includes(liveExisting.setup.stage) || (liveExisting.setup.stage === "awaiting_consent" && !liveExisting.setup.consent)) ? liveExisting.setup : null;
  // One still waiting for the owner's consent: 繼續設定 reopens the confirm sheet.
  const consentSetup = liveExisting?.setup?.stage === "awaiting_consent" && liveExisting.setup.consent ? liveExisting.setup : null;
  if (testnet && liveExisting && endedSetup && !started) {
    const lapsed = endedSetup.stage === "awaiting_consent";
    const busy = live.restart.isPending || live.cancel.isPending;
    return (
      <Shell sheet={sheet}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[0.9375rem] font-bold">{lapsed ? liveText.consentLapsed : endedSetup.stage === "expired" ? liveText.expired : liveText.failed}</p>
        </div>
        <p role={lapsed ? undefined : "alert"} className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />{lapsed ? liveText.consentLapsedHint : liveSetupError(copyTexts, endedSetup.issue)}
        </p>
        <Button type="button" size="cta" className="w-full" loading={live.restart.isPending} disabled={busy && !live.restart.isPending} onClick={() => void restartTestnet(endedSetup.id)}>
          {liveText.restart}
        </Button>
        <Button type="button" variant="secondary" className="w-full" loading={live.cancel.isPending} disabled={busy && !live.cancel.isPending} onClick={() => void cancelTestnet(endedSetup.id)}>{liveText.cancelSetup}</Button>
        {liveDialogs}
      </Shell>
    );
  }

  // A testnet copy of this trader: its stage and budget, managed in the portfolio.
  const settingUp = Boolean(liveExisting?.setup && liveExisting.setup.kind === "start" && !["running", "failed", "expired", "cancelled"].includes(liveExisting.setup.stage));
  if (testnet && liveExisting && !started) {
    return (
      <Shell sheet={sheet}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[0.9375rem] font-bold">{settingUp ? liveText.progressTitle : liveText.copying}</p>
        </div>
        <dl className="grid grid-cols-2 gap-2 rounded-xl bg-inset p-3 text-center">
          <div>
            <dt className="text-[11px] text-muted-foreground">{liveText.budget}</dt>
            <dd className="num mt-1 text-sm font-bold">{format.usd(Number(liveExisting.budgetUsd), { digits: 2 })}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">{liveText.status}</dt>
            <dd className="mt-1 text-sm font-bold">{consentSetup ? liveText.awaitingConsent : liveExisting.setup && !["running", "failed", "expired", "cancelled"].includes(liveExisting.setup.stage) ? liveText.preparing : liveCopiesMessages[locale].stages[liveExisting.stage]}</dd>
          </div>
        </dl>
        {consentSetup ? (
          <Button type="button" size="cta" className="w-full" loading={live.start.isPending} onClick={() => setProgressId(consentSetup.id)}>
            {liveText.continueSetup}
          </Button>
        ) : null}
        <Link
          href="/portfolio"
          className={consentSetup ? "flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-inset text-sm font-bold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
            : "orbit-press flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary px-8 font-display text-lg text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"}
        >
          {consentSetup ? null : <Check className="size-5" strokeWidth={2.5} />}
          {liveText.manage}
        </Link>
        {liveDialogs}
      </Shell>
    );
  }

  // Paper-started state: this user already copies the trader.
  if (!testnet && existing && !started) {
    const pnl = existing.totalPnl;
    return (
      <Shell sheet={sheet}>
        {hedgeNotice}
        <div className="flex items-center justify-between gap-2">
          <p className="text-[0.9375rem] font-bold">{t("trader.copy.copying")}</p>
          <div className="flex items-center gap-1.5">
            {existing.status === "paused" ? <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{t("trader.copy.paused")}</span> : null}
            {existing.status === "stopping" ? <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{t("trader.copy.stopping")}</span> : null}
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
          className="orbit-press flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary px-8 font-display text-lg text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Check className="size-5" strokeWidth={2.5} />
          {t("trader.copy.manage")}
        </Link>
      </Shell>
    );
  }

  return (
    <Shell sheet={sheet} spaced>
     {/* A real form: Enter in the amount field starts the copy. */}
     <form className="contents" noValidate onSubmit={(event) => { event.preventDefault(); if (!(start.isPending || preparing || started || closed || (empty && !fundFirst))) void submit(); }}>
      {/* Direction stays above the scrolling amount controls. */}
      {sheet ? <div className="sticky top-0 z-10 -mx-5 bg-card px-5 pt-1 pb-2 in-data-[scrolled=true]:shadow-[0_6px_8px_-6px_var(--border)]" data-testid="copy-sheet-direction">{directionPill}</div> : directionPill}
      {hedgeNotice}

      <div className="flex flex-col gap-4">
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
        <div
          ref={fieldRef}
          // The whole row is the field: a press anywhere but 最大 types.
          onPointerDown={(e) => {
            if (amountLocked || (e.target as HTMLElement).closest("button, input")) return;
            e.preventDefault();
            fieldRef.current?.querySelector<HTMLInputElement>("input")?.focus();
          }}
          data-testid="copy-amount-row"
          className={cn("flex min-w-0 items-center gap-2.5 rounded-2xl bg-inset px-4", amountLocked ? "cursor-not-allowed" : "cursor-text")}
          style={{ height: AMOUNT_ROW_PX }}
        >
          <label className="sr-only" htmlFor="copy-amount">
            {t("trader.copy.amount")}
          </label>
          <input
            id="copy-amount"
            inputMode="decimal"
            placeholder="0"
            disabled={amountLocked}
            value={amount}
            onChange={(e) => {
              setAmount(amountInput(e.target.value, amount).slice(0, 12));
            }}
            onBlur={() => {
              // CopyDog clamps to the whole-dollar balance when focus leaves.
              if (amount && Number.isFinite(value) && balanceKnown) setAmount(String(Math.min(Math.floor(value), Math.floor(balance))));
            }}
            className="num min-w-[1ch] bg-transparent p-0 font-display leading-none outline-none placeholder:text-foreground disabled:cursor-not-allowed disabled:placeholder:text-muted-foreground"
            style={{ width: `${Math.max(1, (amount || "0").length)}ch`, fontSize: amountPx }}
          />
          {/* Orbit: the amount is the big figure, the unit a quiet suffix. */}
          <span className="shrink-0 self-center pt-[0.35em] font-display leading-none text-muted-foreground" style={{ fontSize: AMOUNT_UNIT_PX }}>USDC</span>
          <button
            type="button"
            onClick={() => setFromPct(100)}
            disabled={balance <= 0}
            className="orbit-press ml-auto shrink-0 self-center rounded-full bg-card px-4 py-2.5 text-[13px] leading-5 font-extrabold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("trader.copy.max")}
          </button>
        </div>
      )}

      {sheet ? (
        <>
          <div className="grid grid-cols-4 gap-2">
            {[25, 50, 75, 100].map((p) => {
              const preset = presetOf(p);
              return (
                <button
                  key={p}
                  type="button"
                  disabled={balance <= 0}
                  onClick={() => setFromPct(p)}
                  className={cn(
                    "h-11 rounded-full text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
            {/* One format for both modes: 可用 0 USDC（主錢包）. */}
            <span className="num ml-auto text-sm font-bold" data-testid="copy-available">
              {t("trader.copy.availableFrom", { amount: balanceKnown ? format.num(balance, 2) : "—", source: testnet ? liveText.testnetBalance : t("trader.copy.paperAccount") })}
            </span>
          </div>
          <div role="group" aria-label={t("trader.copy.amount")} className="grid grid-cols-3 gap-1">
            {KEYPAD.flat().map((k) => (
              <button
                key={k}
                type="button"
                disabled={amountLocked}
                aria-label={k === "del" ? t("trader.copy.backspace") : k}
                onClick={() => {
                  setAmount((a) => (k === "del" ? a.slice(0, -1) : `${a}${k}`.replace(/^0+(?=\d)/, "").slice(0, 12)));
                }}
                className="flex h-12 items-center justify-center rounded-xl text-xl font-semibold outline-none active:bg-raised focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
              >
                {k === "del" ? <Delete className="size-6" strokeWidth={1.8} /> : k}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3 rounded-2xl bg-inset px-4 py-3" data-testid="copy-balance-card">
          <div className="flex items-center justify-between gap-3 text-sm leading-[21px]">
            <span className="flex items-center gap-2 text-muted-foreground">
              {testnet ? <span className="whitespace-nowrap">{liveText.testnetBalance}</span> : t("trader.copy.balance")}
            </span>
            <span className="num font-semibold">{balanceText} USDC</span>
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
            <span className="num min-w-[3.5ch] shrink-0 text-right text-sm leading-[21px] font-bold">{pct}%</span>
          </div>
        </div>
      )}

      </div>

      <div>
        <CollapsibleTrigger
          open={more}
          controls={sheet ? "copy-more-sheet" : "copy-more"}
          onOpenChange={setMore}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded border-t-2 border-dotted border-border pt-2 text-sm leading-5 font-extrabold text-foreground outline-none hover:text-primary-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("trader.copy.more")}
          <ChevronDown className={cn("size-3 transition-transform", more && "rotate-180")} />
        </CollapsibleTrigger>
        <Collapsible id={sheet ? "copy-more-sheet" : "copy-more"} open={more} clipClassName="-m-0.5 p-0.5">
            <div className="mt-3 flex items-center justify-between gap-3">
              <span id="copy-positions" className="text-[13px] font-semibold" title={t("trader.copy.copyPositionsDesc")}>
                {t("trader.copy.copyPositions")}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={testnet ? false : copyExisting}
                aria-labelledby="copy-positions"
                aria-describedby={testnet ? "copy-positions-note" : undefined}
                disabled={testnet}
                onClick={() => setCopyExisting((v) => !v)}
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                  copyExisting && !testnet ? "bg-primary" : "bg-border-strong",
                )}
              >
                <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-primary-foreground shadow-xs transition-transform", copyExisting && !testnet && "translate-x-4")} />
              </button>
            </div>
            {testnet ? (
              <>
                <p id="copy-positions-note" className="mt-1.5 text-xs leading-5 text-muted-foreground">{liveText.adoptDisabled}</p>
                <LiveSettingsFields text={liveText} sizing={fixedOnly ? "fixed" : sizing} setSizing={setSizing} perTrade={perTrade} setPerTrade={setPerTrade}
                  maxExposure={maxExposure} setMaxExposure={setMaxExposure} maxLeverage={maxLeverage} setMaxLeverage={setMaxLeverage} fixedOnly={fixedOnly} leverageCap={leverageCap} />
              </>
            ) : null}
        </Collapsible>
      </div>

      {paused ? (
        <p className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {t(overview.data?.platform.pauseNewRisk || overview.data?.platform.reduceOnly ? "trader.copy.platformPaused" : "trader.copy.userPaused")}
        </p>
      ) : null}

      <div className="flex flex-col gap-2.5">
        {/* A start's request is pending for its whole length (a testnet start
            prepares a wallet and an agent: 10-20 s): the orbit mark, no
            second press. */}
        <Button
          type="submit"
          size="cta"
          loading={start.isPending || preparing}
          disabled={!(start.isPending || preparing) && (started || closed || !trading.available || (empty && !fundFirst))}
          className="min-h-14 w-full focus-visible:ring-offset-card disabled:cursor-not-allowed"
        >
          {started ? (
            <>
              <Check className="size-5" strokeWidth={2.5} />
              {t("trader.copy.started")}
            </>
          ) : testnet && preparing ? liveText.preparing : label}
        </Button>
        {testnet && preparing ? <p role="status" className="text-center text-xs leading-5 text-muted-foreground">{liveText.preparingHint}</p>
          : testnet ? <p className="text-center text-xs leading-5 text-muted-foreground">{liveText.testnetNote}</p> : null}
      </div>
     </form>
     {liveDialogs}
    </Shell>
  );
}

/**
 * The amount a new copy may take: 模擬 within the paper limits (CopyDog's
 * $100 floor until they load); 正式 / 測試網 within the deployment's caps
 * (its per-trade minimum, else 1, and its largest budget, none when unset).
 */
export function copyAmountBounds(live: boolean, paper: { minAllocationUsd: number; maxAllocationUsd: number } | undefined,
  caps: { fixedPerTradeUsd: { min: number } | null; maxAllocationUsd: number | null } | null | undefined): { min: number; max: number | null } {
  if (live) return { min: caps?.fixedPerTradeUsd?.min ?? 1, max: caps?.maxAllocationUsd ?? null };
  return { min: paper?.minAllocationUsd ?? DEFAULT_MIN, max: paper?.maxAllocationUsd ?? null };
}

function Shell({ sheet, spaced = false, children }: { sheet: boolean; spaced?: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  return sheet ? (
    <div className="flex flex-col gap-4 px-1">{children}</div>
  ) : (
    // The copy form: 32 px between its blocks (Paul, 2026-10-07); a block's
    // own parts sit 16 px apart.
    <aside aria-label={t("trader.copy.panel")} className={cn("orbit-card card-pad flex flex-col xl:sticky xl:top-[92px]", spaced && "gap-8")}>{children}</aside>
  );
}
