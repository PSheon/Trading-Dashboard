"use client";

import { ArrowUp, Bell, ChartPie, ChevronDown, Plus, Settings, ShoppingCart, UserPlus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { ActivityPanel } from "@/components/copy/activity-panel";
import { CopyActivity } from "@/components/copy/copy-activity";
import { CopyCards, CopyDetail, CopyListSkeleton, CopyTable, useLeaders } from "@/components/copy/copy-portfolio";
import { LiveCopies } from "@/components/copy/live-copies";
import { ExposurePanel, InsightsPanel, PaperSummary, PaperSummarySkeleton, PortfolioChart, PortfolioChartSkeleton } from "@/components/copy/portfolio-parts";
import { ErrorState, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { NetworkBadge } from "@/components/wallet/bits";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import type { CopyOverview, WalletSummary } from "@/lib/contracts";
import { useCopyOverview, useCopyPortfolio } from "@/lib/copy";
import { useWallet } from "@/lib/wallet";

type Tab = "copying" | "insights" | "exposure";

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
        <div className="hidden md:block">
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
      <CopyActivity />
    </>
  );
}

function SignedOut() {
  const { t } = useI18n();
  const { status, login } = useAuth();
  return (
    <div className="orbit-card mx-auto mt-10 flex w-full max-w-[460px] flex-col items-center gap-3 rounded-[32px]! px-8 py-10 text-center md:mt-[120px]">
      <span className="mb-2 flex size-24 items-center justify-center rounded-full bg-raised"><ShoppingCart className="size-11 text-primary-text" strokeWidth={2} aria-hidden /></span>
      <h1 className="type-h1">{t("portfolio.signInTitle")}</h1>
      <p className="text-base leading-6 font-bold text-muted-foreground">{t("portfolio.signInBody")}</p>
      <Button size="cta" className="mt-5 w-[200px]" onClick={login} disabled={status === "disabled"}>
        {t("common.signIn")}
      </Button>
    </div>
  );
}

function TotalValue({ wallet, className }: { wallet: ReturnType<typeof useWallet>; className?: string }) {
  const { format } = useI18n();
  if (wallet.data) {
    return <p className={cn("num font-extrabold", className)}>{format.usd(wallet.data.totalValue, { digits: 2 })}</p>;
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

function Breakdown({ summary }: { summary: WalletSummary }) {
  const { t, format } = useI18n();
  const rows = [
    { label: t("portfolio.perp"), value: summary.hyperliquid?.perpValue ?? 0 },
    { label: t("portfolio.spot"), value: summary.hyperliquid?.spotUsdc ?? 0 },
    { label: t("portfolio.arbitrum"), value: summary.arbitrum?.usdc ?? 0 },
  ];
  return (
    <dl className="mt-3 grid gap-1.5 rounded-xl bg-inset p-3 text-xs font-bold">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="num font-semibold">{format.usd(r.value, { digits: 2 })}</dd>
        </div>
      ))}
    </dl>
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
  const { t } = useI18n();
  const [selected, select] = useSelectedCopy();
  const leaders = useLeaders(overview.strategies);
  const [tab, setTab] = useState<Tab>("copying");
  const sparklines = useSparklines(overview.strategies.length > 0);
  const strategy = overview.strategies.find((s) => s.id === selected);
  if (strategy) {
    return (
      <CopyDetail
        strategy={strategy}
        leader={leaders.get(strategy.leaderAddress) ?? { address: strategy.leaderAddress, displayName: null, avatarUrl: null }}
        balance={overview.paper.balance}
        onBack={() => select(null)}
      />
    );
  }
  // Testnet copies (real orders on Hyperliquid testnet) list above the paper ones.
  const live = <LiveCopies className="mb-4" />;
  if (overview.strategies.length === 0) return <>{live}<EmptyCopying className={phone ? undefined : "mt-14 px-6"} /></>;
  if (phone) return <>{live}<CopyCards strategies={overview.strategies} leaders={leaders} onSelect={select} sparklines={sparklines} /></>;
  const values = ["copying", "insights", "exposure"] as const;
  return (
    <>
    {live}
    <section>
      <div role="tablist" aria-label={t("portfolio.title")} className="mb-1 flex gap-1">
        {values.map((value) => (
          <button
            key={value}
            id={`desktop-copy-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            aria-controls="desktop-copy-panel"
            onKeyDown={(event) => {
              const index = values.indexOf(value);
              const next = event.key === "ArrowRight" ? values[(index + 1) % values.length] : event.key === "ArrowLeft" ? values[(index + values.length - 1) % values.length] : event.key === "Home" ? values[0] : event.key === "End" ? values[values.length - 1] : null;
              if (next) { event.preventDefault(); setTab(next); document.getElementById(`desktop-copy-tab-${next}`)?.focus(); }
            }}
            onClick={() => setTab(value)}
            className={cn(
              "flex h-11 items-center gap-2 rounded-full px-4 text-[15px] outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
              tab === value ? "bg-primary font-extrabold text-primary-foreground" : "font-bold text-muted-foreground hover:bg-raised hover:text-foreground",
            )}
          >
            {t(`portfolio.tabs.${value}`)}
            {value === "copying" ? <span className={cn("num inline-flex size-6 items-center justify-center rounded-full font-display text-xs", tab === value ? "bg-card/80 text-foreground" : "bg-raised text-foreground")}>{overview.strategies.length}</span> : null}
          </button>
        ))}
      </div>
      <div id="desktop-copy-panel" role="tabpanel" aria-labelledby={`desktop-copy-tab-${tab}`}>
        {tab === "copying" ? <CopyTable strategies={overview.strategies} leaders={leaders} onSelect={select} sparklines={sparklines} bare />
          : tab === "insights" ? <InsightsPanel overview={overview} leaders={leaders} onSelect={(id) => select(id)} desktop />
          : <ExposurePanel overview={overview} leaders={leaders} desktop />}
      </div>
    </section>
    </>
  );
}

function DesktopPortfolio() {
  const { t } = useI18n();
  const wallet = useWallet();
  const copy = useCopyOverview();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="type-h1">{t("portfolio.title")}</h1>
      <div className="flex flex-wrap items-stretch gap-4">
        <section className="orbit-card card-pad flex w-[340px] flex-col gap-2" aria-label={t("portfolio.totalValue")}>
          {/* min-h-6: the testnet badge's height, so its arrival moves nothing. */}
          <div className="flex min-h-6 items-center justify-between gap-2">
            <p className="text-[13px] font-bold text-muted-foreground">{t("portfolio.totalValue")}</p>
            <NetworkBadge network={wallet.data?.network} />
          </div>
          <button
            type="button"
            className="flex items-center gap-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            aria-label={t("portfolio.breakdown")}
            onClick={() => setOpen((v) => !v)}
            disabled={!wallet.data}
          >
            <TotalValue wallet={wallet} className="font-display text-[2.5rem] leading-tight" />
          </button>
          {open && wallet.data ? <Breakdown summary={wallet.data} /> : null}
          {wallet.isError && !wallet.data ? <ErrorState onRetry={() => wallet.refetch()} /> : null}
          <FundButtons className="mt-auto pt-2" />
        </section>
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
        {(["copying", "insights", "exposure"] as const).map((value) => (
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
  const { t } = useI18n();
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>("copying");
  const [open, setOpen] = useState(false);
  const tabs: { value: Tab; label: string }[] = [
    { value: "copying", label: t("portfolio.tabs.copying") },
    { value: "insights", label: t("portfolio.tabs.insights") },
    { value: "exposure", label: t("portfolio.tabs.exposure") },
  ];

  return (
    <div className="-mx-4 -mt-4">
      <PhoneHeader />
      <PhoneBody tab={tab} setTab={setTab} tabs={tabs} wallet={wallet} open={open} setOpen={setOpen} />
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

function PhoneBody({
  tab,
  setTab,
  tabs,
  wallet,
  open,
  setOpen,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  tabs: { value: Tab; label: string }[];
  wallet: ReturnType<typeof useWallet>;
  open: boolean;
  setOpen: (update: (value: boolean) => boolean) => void;
}) {
  const { t } = useI18n();
  const copy = useCopyOverview();
  return (
    <>
      <div className="orbit-card mx-4 mt-3 px-5 py-4">
        <div className="flex min-h-6 items-center gap-2">
          <p className="text-[13px] font-bold text-muted-foreground">{t("portfolio.totalValue")}</p>
          <NetworkBadge network={wallet.data?.network} />
        </div>
        <button
          type="button"
          className="flex w-full items-center justify-between text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          aria-label={t("portfolio.breakdown")}
          onClick={() => setOpen((v) => !v)}
          disabled={!wallet.data}
        >
          <TotalValue wallet={wallet} className="font-display text-[2.25rem] leading-tight" />
          <ChevronDown className={cn("size-5 text-muted-foreground transition-transform duration-200", open && "rotate-180")} strokeWidth={2.4} />
        </button>
        {open && wallet.data ? <Breakdown summary={wallet.data} /> : null}
        <FundButtons className="mt-3" />
      </div>

      <div className="px-4 pt-4">
        <div role="tablist" aria-label={t("portfolio.title")} className="grid grid-flow-col gap-0.5 rounded-full bg-raised p-1">
          {tabs.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "h-11 rounded-full px-3 text-[0.9375rem] outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
                tab === item.value ? "bg-primary font-extrabold text-primary-foreground" : "font-bold text-muted-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={copy.data && copy.data.strategies.length === 0 ? "pt-8" : "pt-4 pb-6"}>
          <PhoneTab tab={tab} copy={copy} setTab={setTab} />
        </div>
      </div>
    </>
  );
}

function PhoneTab({ tab, copy, setTab }: { tab: Tab; copy: ReturnType<typeof useCopyOverview>; setTab: (tab: Tab) => void }) {
  const { t } = useI18n();
  const leaders = useLeaders(copy.data?.strategies ?? []);
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
  if (tab === "insights") {
    return has ? <InsightsPanel overview={copy.data} leaders={leaders} onSelect={(id) => { select(id); setTab("copying"); }} desktop={false} /> : <TabEmpty icon={ChartPie} title={t("portfolio.insightsEmptyTitle")} body={t("portfolio.insightsEmptyBody")} />;
  }
  return has ? <ExposurePanel overview={copy.data} leaders={leaders} desktop={false} /> : <TabEmpty icon={ChartPie} title={t("portfolio.exposureEmptyTitle")} body={t("portfolio.exposureEmptyBody")} />;
}
