"use client";

import { ArrowUp, Bell, ChartPie, Plus, Settings, ShoppingCart, UserPlus, type LucideIcon } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";

import { ActivityPanel } from "@/components/copy/activity-panel";
import { CopyActivity } from "@/components/copy/recent-activity";
import { CopyCards, CopyDetail, CopyListSkeleton, CopyTable, useLeaders } from "@/components/copy/copy-portfolio";
import { LiveCopies } from "@/components/copy/live-copies";
import { CopyEquityProbes, useCopiesEquity } from "@/lib/copy-equity";
import { ExposurePanel, InsightsPanel, PaperSummary, PaperSummarySkeleton, PortfolioChart, PortfolioChartSkeleton } from "@/components/copy/portfolio-parts";
import { ErrorState, Skeleton } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { boardName } from "@/components/discover/board-bits";
import { useLiveCopyPortfolio } from "@/lib/copy-live-portfolio";
import { useSiteMode, useTradingMode } from "@/lib/site-mode";
import { useLiveCopyDeployment } from "@/lib/copy-live-setup";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import type { CopyOverview } from "@/lib/contracts";
import { useCopyOverview, useCopyPortfolio } from "@/lib/copy";
import { useWallet } from "@/lib/wallet";
import { walletTotalValue } from "@/lib/wallet-value";
import { SwitchPanel } from "@/components/ui/switch-panel";

type Tab = "copying" | "insights" | "exposure" | "activity";
/** 跟單中 / 洞察 / 曝險 / 動態 (Paul, 2026-10-07: 最近活動 is the fourth tab). */
const TAB_ORDER: readonly Tab[] = ["copying", "insights", "exposure", "activity"];

/**
 * 投資組合, as on CopyDog (`/hyperliquid/portfolio`):
 * - signed out: 登入以查看你的投資組合 and 登入;
 * - desktop: the 總價值 card (＋儲值 / ↑提款) and, beside it, the 模擬 paper
 *   account; below, CopyDog's copy list (empty: 你尚未跟單任何交易員 +
 *   尋找交易員). A row opens that copy (`?copy=<id>`): summary, pause /
 *   resume, edit, add funds, stop, settings, positions and paper orders;
 * - phone: its own header (title, bell, gear → settings), total value with
 *   a breakdown chevron, 儲值 / 提款, and Copying / Insights / Exposure tabs
 *   filled from the paper copies.
 */
export function PortfolioView() {
  const { status } = useAuth();
  if (status === "loading") {
    // The signed-in page in its loading state (its reads wait for the
    // session): a returning visitor's page fills in where it stands.
    return (
      <div aria-busy="true">
        <div className="hidden md:block">
          <DesktopPortfolio />
        </div>
        <div className="md:hidden">
          <PhonePortfolio />
        </div>
      </div>
    );
  }
  if (status !== "signedIn") {
    return (
      <>
        <div className="hidden md:block md:w-full">
          <SignedOut />
        </div>
        <div className="md:hidden">
          <PhoneSignedOut />
        </div>
      </>
    );
  }
  return (
    <>
      <div className="hidden md:block">
        <DesktopPortfolio />
      </div>
      <div className="md:hidden">
        <PhonePortfolio />
      </div>
    </>
  );
}

type View = "real" | "paper";
/** All portfolio layouts follow the account menu's shared selection. */
function usePortfolioView(): View {
  const { mode, select, deploymentNetwork, pending } = useTradingMode();
  const search = useSearchParams();
  const legacy = search.get("view");
  useEffect(() => {
    if (legacy !== "paper" && legacy !== "real") return;
    const next = legacy === "paper" ? "paper" : deploymentNetwork === "mainnet" ? "live" : "testnet";
    if (!select(next)) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [legacy, deploymentNetwork, select, pending]);
  return mode === "paper" ? "paper" : "real";
}

/** 我的資金: one figure (the main wallet and the money in real copies), the two parts under it, 儲值 and 提款. */
function MyFunds({ wallet, inCopies, className }: { wallet: ReturnType<typeof useWallet>; inCopies: number | null; className?: string }) {
  const { t, format } = useI18n();
  const main = walletTotalValue(wallet.data);
  return (
    <section className={cn("orbit-card card-pad flex flex-col gap-3", className)} aria-label={t("folio.myFunds")} data-testid="my-funds">
      <p className="text-[13px] font-bold text-muted-foreground">{t("folio.myFunds")}</p>
      {main !== null ? <p className="num font-display text-[2.25rem] leading-tight">{inCopies === null ? "—" : format.usd(main + inCopies, { digits: 2 })}</p> : <TotalValue wallet={wallet} className="font-display text-[2.25rem] leading-tight" />}
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-muted-foreground">{t("folio.mainWallet")}</dt><dd className="num mt-0.5 text-sm font-bold">{main === null ? "—" : format.usd(main, { digits: 2 })}</dd></div>
        <div><dt className="text-muted-foreground">{t("folio.inCopies")}</dt><dd className="num mt-0.5 text-sm font-bold">{inCopies === null ? t("folio.balancePending") : format.usd(inCopies, { digits: 2 })}</dd></div>
      </dl>
      {main !== null && inCopies !== null && inCopies !== 0 ? <p className="text-xs leading-5 text-muted-foreground">{t("liveCopyUi.roundingHint")}</p> : null}
      {wallet.isError && !wallet.data ? <ErrorState onRetry={() => wallet.refetch()} /> : null}
      {wallet.data && main === null ? <p role="status" className="text-xs text-muted-foreground">{t("folio.balancePending")}</p> : null}
      <FundButtons />
    </section>
  );
}

function NoCopies() {
  const { t } = useI18n();
  return (
    <div className="orbit-card card-pad flex flex-col items-center gap-2 text-center">
      <p className="font-display text-lg">{t("folio.emptyTitle")}</p>
      <p className="text-sm font-bold text-muted-foreground">{t("folio.emptyBody")}</p>
      <Link href="/explore" className={cn(buttonVariants(), "mt-2")}>{t("folio.find")}</Link>
    </div>
  );
}

/** 正式, or, where real copies run for invited users only and this one is
 * not yet (`actualAllowed: false`), the one sentence that says so: no
 * funds card and no 儲值 to a copy that cannot start. */
function RealView() {
  const { t } = useI18n();
  const deployment = useLiveCopyDeployment();
  const mode = useSiteMode();
  if (deployment?.inviteOnly || !deployment?.available || deployment.network !== (mode === "live" ? "mainnet" : "testnet")) {
    return (
      <div className="orbit-card card-pad flex flex-col items-center gap-2 text-center" data-view="real" data-testid="invite-only">
        <p className="font-display text-lg">{t(deployment?.inviteOnly ? "folio.inviteOnly" : "mode.unavailable")}</p>
      </div>
    );
  }
  return <RealPortfolio />;
}

/** 正式: 我的資金, 跟單中 (compact cards, a detail sheet each), 已結束 and 最近活動. */
function RealPortfolio() {
  const { t } = useI18n();
  const wallet = useWallet();
  const live = useLiveCopyPortfolio();
  const items = useMemo(() => live.data?.items ?? [], [live.data]);
  const leaders = useLeaders(items);
  // 我的資金 and the header's pill: one total (lib/copy-equity).
  const inCopies = useCopiesEquity();
  const names = useMemo(() => new Map(items.map((item) => [item.strategyId, boardName(leaders.get(item.leaderAddress) ?? { address: item.leaderAddress, displayName: null })])), [items, leaders]);
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start lg:gap-5" data-view="real">
      <div className="flex flex-col gap-4 lg:sticky lg:top-24">
        <MyFunds wallet={wallet} inCopies={inCopies} />
        <CopyEquityProbes />
      </div>
      {/* The right column: the copies, then their activity across the width. */}
      <div className="flex min-w-0 flex-col gap-4">
        <LiveCopies empty={<NoCopies />} />
        <section className="orbit-card card-pad" aria-label={t("folio.copyActivity")}>
          <h2 className="text-[0.9375rem] font-extrabold">{t("folio.copyActivity")}</h2>
          <CopyActivity names={names} className="mt-1" />
        </section>
      </div>
    </div>
  );
}

/** The paper copies' names (strategy id → trader), for 最近活動. */
function usePaperNames(overview: CopyOverview | undefined) {
  const strategies = useMemo(() => overview?.strategies ?? [], [overview]);
  const leaders = useLeaders(strategies);
  return useMemo(() => new Map(strategies.map((s) => [s.id, boardName(leaders.get(s.leaderAddress) ?? { address: s.leaderAddress, displayName: null })])), [strategies, leaders]);
}

function SignedOut() {
  const { t } = useI18n();
  const { status, login } = useAuth();
  return (
    <div className="orbit-card mx-auto flex w-full max-w-[560px] flex-col items-center gap-3 rounded-[32px]! px-8 py-6 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-raised"><ShoppingCart className="size-8 text-primary-text" strokeWidth={2} aria-hidden /></span>
      <h1 className="type-h1 md:text-[2rem] md:leading-tight">{t("portfolio.signInTitle")}</h1>
      <p className="text-base leading-6 font-bold text-muted-foreground">{t("portfolio.signInBody")}</p>
      <Button size="cta" className="mt-3 w-[200px]" onClick={login} disabled={status === "disabled"}>
        {t("common.signIn")}
      </Button>
    </div>
  );
}

function TotalValue({ wallet, className }: { wallet: ReturnType<typeof useWallet>; className?: string }) {
  const { format } = useI18n();
  if (wallet.data) {
    const total = walletTotalValue(wallet.data);
    return <p className={cn("num font-extrabold", className)}>{total === null ? "—" : format.usd(total, { digits: 2 })}</p>;
  }
  if (wallet.isError) return <p className={cn("num font-extrabold text-muted-foreground", className)}>—</p>;
  // A bar on the figure's own line (same font size and leading).
  return (
    <p aria-hidden="true" className={cn("num flex h-[1.25em] items-center font-extrabold", className)}>
      <span className="ui-skeleton block h-[0.75em] w-[4.5em] rounded-full bg-raised" />
    </p>
  );
}

function FundButtons({ className }: { className?: string }) {
  const { t } = useI18n();
  const { openDeposit, openWithdraw } = useWalletModals();
  return (
    <div className={cn("grid grid-cols-2 gap-3", className)}>
      <Button onClick={openDeposit}>
        <Plus />
        {t("portfolio.deposit")}
      </Button>
      <Button variant="secondary" onClick={openWithdraw}>
        <ArrowUp />
        {t("portfolio.withdraw")}
      </Button>
    </div>
  );
}

function EmptyCopying({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <TabEmpty icon={UserPlus} title={t("portfolio.emptyTitle")} body={t("portfolio.emptyBody")} className={className}>
      <Button asChild size="cta" className="mt-5 w-full">
        <Link href="/explore">{t("portfolio.cta")}</Link>
      </Button>
    </TabEmpty>
  );
}

function TabEmpty({
  icon: Icon,
  title,
  body,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", className)}>
      <span className="flex size-20 items-center justify-center rounded-full bg-raised"><Icon className="size-9 text-primary-text" strokeWidth={2} aria-hidden /></span>
      <p className="mt-4 font-display text-xl">{title}</p>
      <p className="mt-2 text-sm font-bold text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}

/** The open copy, in the query string so the trader panel can link to it. */
function useSelectedCopy(): [number | null, (id: number | null) => void] {
  const params = useSearchParams();
  const raw = Number(params.get("copy"));
  const set = (id: number | null) => {
    // Selection is local UI state; Next syncs native history with useSearchParams.
    // Read the current URL so rapid actions also retain newer query/hash changes.
    const qs = new URLSearchParams(window.location.search);
    if (id === null) qs.delete("copy");
    else qs.set("copy", String(id));
    const query = qs.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  };
  return [Number.isInteger(raw) && raw > 0 ? raw : null, set];
}

/** Each copy's PnL curve since it started (the list's equity-curve column). */
function useSparklines(enabled: boolean): Map<number, ReadonlyArray<number | null>> {
  const portfolio = useCopyPortfolio("all", enabled);
  return useMemo(() => new Map((portfolio.data?.sparklines ?? []).map((s) => [s.strategyId, s.points])), [portfolio.data]);
}

/** The copy list, or the selected copy, of a loaded overview. Desktop:
 * CopyDog's card with the COPYING (count) / INSIGHTS / EXPOSURE tabs. */
function CopyingSection({ overview, phone }: { overview: CopyOverview; phone: boolean }) {
  const [selected, select] = useSelectedCopy();
  const strategy = overview.strategies.find((s) => s.id === selected);
  // List ↔ detail slides (Paul, 2026-10-07): into a copy from the right,
  // back to the list from the left; reduced motion switches at once.
  return (
    <SwitchPanel value={strategy ? "detail" : "list"} order={VIEW_ORDER}>
      {strategy ? <CopyDetailOf overview={overview} strategy={strategy} onBack={() => select(null)} /> : <CopyList overview={overview} phone={phone} onSelect={select} />}
    </SwitchPanel>
  );
}

const VIEW_ORDER = ["list", "detail"] as const;

function CopyDetailOf({ overview, strategy, onBack }: { overview: CopyOverview; strategy: CopyOverview["strategies"][number]; onBack: () => void }) {
  const leaders = useLeaders(overview.strategies);
  return (
    <CopyDetail
      strategy={strategy}
      leader={leaders.get(strategy.leaderAddress) ?? { address: strategy.leaderAddress, displayName: null, avatarUrl: null }}
      balance={overview.paper.balance}
      onBack={onBack}
    />
  );
}

function CopyList({ overview, phone, onSelect: select }: { overview: CopyOverview; phone: boolean; onSelect: (id: number) => void }) {
  const { t } = useI18n();
  const leaders = useLeaders(overview.strategies);
  const names = usePaperNames(overview);
  const [tab, setTab] = useState<Tab>("copying");
  const sparklines = useSparklines(overview.strategies.length > 0);
  if (overview.strategies.length === 0) return <EmptyCopying className={phone ? undefined : "mt-14 px-6"} />;
  if (phone) return <CopyCards strategies={overview.strategies} leaders={leaders} onSelect={select} sparklines={sparklines} />;
  const values = TAB_ORDER;
  return (
    <section>
      <Tabs value={tab} onChange={setTab} label={t("portfolio.title")} idPrefix="desktop-copy-tab" controls="desktop-copy-panel" className="mb-1"
        items={values.map((value) => ({ value, label: t(`portfolio.tabs.${value}`),
          badge: value === "copying" ? <span className={cn("num inline-flex size-6 items-center justify-center rounded-full font-display text-xs", tab === value ? "bg-card/80 text-foreground" : "bg-raised text-foreground")}>{overview.strategies.length}</span> : null }))} />
      <SwitchPanel value={tab} order={TAB_ORDER} id="desktop-copy-panel" role="tabpanel" aria-labelledby={`desktop-copy-tab-${tab}`}>
        {tab === "copying" ? <CopyTable strategies={overview.strategies} leaders={leaders} onSelect={select} sparklines={sparklines} bare />
          : tab === "insights" ? <InsightsPanel overview={overview} leaders={leaders} onSelect={(id) => select(id)} desktop />
          : tab === "exposure" ? <ExposurePanel overview={overview} leaders={leaders} desktop />
          : <CopyActivity names={names} className="orbit-card card-pad" />}
      </SwitchPanel>
    </section>
  );
}

function DesktopPortfolio() {
  const { t } = useI18n();
  const view = usePortfolioView();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="type-h1">{t("portfolio.title")}</h1>
      </div>
      <div id="portfolio-view-panel" >
        {view === "real" ? <RealView /> : <DesktopPaper />}
      </div>
    </div>
  );
}

/** 模擬 on desktop: the paper account and its chart, the paper copies, their activity. */
function DesktopPaper() {
  const copy = useCopyOverview();
  return (
    <div className="flex flex-col gap-5" data-view="paper">
      <div className="flex flex-wrap items-stretch gap-4">
        {copy.data ? <PaperSummary overview={copy.data} className="w-[340px]" /> : !copy.isError ? <PaperSummarySkeleton className="w-[340px]" /> : null}
        {copy.data && copy.data.strategies.length > 0 ? (
          <PortfolioChart overview={copy.data} className="min-w-[420px] flex-1" />
        ) : !copy.data && !copy.isError ? (
          <PortfolioChartSkeleton className="min-w-[420px] flex-1" />
        ) : null}
      </div>
      {copy.data ? (
        <CopyingSection overview={copy.data} phone={false} />
      ) : copy.isError ? (
        <ErrorState onRetry={() => copy.refetch()} />
      ) : (
        <CopySectionSkeleton />
      )}
    </div>
  );
}

/** CopyingSection while /me/copy loads: its tab row (COPYING lit) over the
 * list's header and rows. */
function CopySectionSkeleton() {
  const { t } = useI18n();
  return (
    <section aria-hidden="true">
      <div className="mb-1 flex gap-1">
        {TAB_ORDER.map((value) => (
          <span
            key={value}
            className={cn(
              "flex h-11 items-center gap-2 rounded-full px-4 text-[15px]",
              value === "copying" ? "bg-primary font-extrabold text-primary-foreground" : "font-bold text-muted-foreground",
            )}
          >
            {t(`portfolio.tabs.${value}`)}
            {value === "copying" ? <span className="inline-flex size-6 rounded-full bg-card/80" /> : null}
          </span>
        ))}
      </div>
      <CopyListSkeleton />
    </section>
  );
}

function PhonePortfolio() {
  const [tab, setTab] = useState<Tab>("copying");
  const view = usePortfolioView();
  return (
    <div className="-mx-4 -mt-4">
      <PhoneHeader />
      <div id="portfolio-view-panel"  className="px-4 pt-4 pb-6">
        {view === "real" ? <RealView /> : <PhonePaper tab={tab} setTab={setTab} />}
      </div>
    </div>
  );
}

/** 投資組合 with the bell (notification settings) and the gear: on phones
 * the gear is how settings are reached, as on CopyDog. */
function PhoneHeader() {
  const { t } = useI18n();
  const [activity, setActivity] = useState(false);
  return (
      <header className="flex items-center justify-between px-4 pt-4">
        <p role="heading" aria-level={1} className="font-display text-[2rem] leading-tight">{t("portfolio.title")}</p>
        <div className="flex items-center gap-2">
          {/* CopyDog: the bell opens the Activity panel (copies, following, deposits). */}
          <button
            type="button"
            onClick={() => setActivity(true)}
            aria-label={t("feed.title")}
            className="orbit-press flex size-11 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bell className="size-[18px]" strokeWidth={2.4} />
          </button>
          <ActivityPanel open={activity} onClose={() => setActivity(false)} />
          <Link
            href="/settings"
            aria-label={t("portfolio.settings")}
            className="orbit-press flex size-11 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings className="size-[18px]" strokeWidth={2.4} />
          </Link>
        </div>
      </header>
  );
}

function PhoneSignedOut() {
  const { t } = useI18n();
  const { status, login } = useAuth();
  return (
    <div className="-mx-4 -mt-4">
      <PhoneHeader />
      <div className="flex flex-col items-center px-6 pt-14 text-center">
        <span className="flex size-20 items-center justify-center rounded-full bg-raised"><ChartPie className="size-9 text-primary-text" strokeWidth={2} aria-hidden /></span>
        <p className="mt-4 font-display text-xl">{t("portfolio.signInTitlePhone")}</p>
        <p className="mt-3 text-sm font-bold text-muted-foreground">{t("portfolio.signInBodyPhone")}</p>
        <Button size="cta" className="mt-3" onClick={login} disabled={status === "disabled"}>
          {t("common.signIn")}
        </Button>
      </div>
    </div>
  );
}

/** 模擬 on phones: the paper copies with 跟單中 / 洞察 / 曝險, then their activity. */
function PhonePaper({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const { t } = useI18n();
  const copy = useCopyOverview();
  return (
    <div className="flex flex-col gap-4" data-view="paper">
      <Tabs value={tab} onChange={setTab} label={t("portfolio.title")} className="seg-track w-full [&>button]:flex-1 [&>button]:justify-center"
        items={TAB_ORDER.map((value) => ({ value, label: t(`portfolio.tabs.${value}`) }))} />
      <SwitchPanel value={tab} order={TAB_ORDER} role="tabpanel" className={copy.data && copy.data.strategies.length === 0 ? "pt-4" : undefined}>
        <PhoneTab tab={tab} copy={copy} setTab={setTab} />
      </SwitchPanel>
    </div>
  );
}

function PhoneTab({ tab, copy, setTab }: { tab: Tab; copy: ReturnType<typeof useCopyOverview>; setTab: (tab: Tab) => void }) {
  const { t } = useI18n();
  const leaders = useLeaders(copy.data?.strategies ?? []);
  const names = usePaperNames(copy.data);
  const [, select] = useSelectedCopy();
  if (!copy.data) {
    if (copy.isError) return <ErrorState onRetry={() => copy.refetch()} />;
    return tab === "copying" ? (
      <div className="flex flex-col gap-4">
        <PaperSummarySkeleton className="p-4" compact />
        <CopyListSkeleton phone />
      </div>
    ) : (
      <Skeleton className="h-60 w-full rounded-2xl" />
    );
  }
  const has = copy.data.strategies.length > 0;
  if (tab === "copying") {
    return (
      <div className="flex flex-col gap-4">
        {has ? <PaperSummary overview={copy.data} className="p-4" collapsible /> : null}
        <CopyingSection overview={copy.data} phone />
      </div>
    );
  }
  if (tab === "activity") return <CopyActivity names={names} />;
  if (tab === "insights") {
    return has ? <InsightsPanel overview={copy.data} leaders={leaders} onSelect={(id) => { select(id); setTab("copying"); }} desktop={false} /> : <TabEmpty icon={ChartPie} title={t("portfolio.insightsEmptyTitle")} body={t("portfolio.insightsEmptyBody")} />;
  }
  return has ? <ExposurePanel overview={copy.data} leaders={leaders} desktop={false} /> : <TabEmpty icon={ChartPie} title={t("portfolio.exposureEmptyTitle")} body={t("portfolio.exposureEmptyBody")} />;
}
