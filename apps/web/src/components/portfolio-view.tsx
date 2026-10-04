"use client";

import { ArrowUp, Bell, ChartPie, ChevronDown, Plus, Settings, ShoppingCart, UserPlus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { ActivityPanel } from "@/components/copy/activity-panel";
import { CopyActivity } from "@/components/copy/copy-activity";
import { CopyCards, CopyDetail, CopyTable, useLeaders } from "@/components/copy/copy-portfolio";
import { ExposurePanel, InsightsPanel, PaperSummary, PortfolioChart } from "@/components/copy/portfolio-parts";
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
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-[166px] w-full max-w-[340px]" />
        <Skeleton className="h-40 w-full" />
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
    <div className="flex flex-col items-center gap-3 px-6 pt-16 text-center md:pt-[88px] md:pr-10">
      <ShoppingCart className="mb-1 size-14 text-subtle-foreground" strokeWidth={1.5} aria-hidden />
      <h1 className="text-2xl font-semibold md:text-[28px] md:leading-[42px]">{t("portfolio.signInTitle")}</h1>
      <p className="text-base leading-6 text-muted-foreground">{t("portfolio.signInBody")}</p>
      <Button size="xl" className="mt-5 w-[200px] font-semibold" onClick={login} disabled={status === "disabled"}>
        {t("common.signIn")}
      </Button>
    </div>
  );
}

function TotalValue({ wallet, className }: { wallet: ReturnType<typeof useWallet>; className?: string }) {
  const { format } = useI18n();
  if (wallet.data) {
    return <p className={cn("num font-extrabold tracking-tight", className)}>{format.usd(wallet.data.totalValue, { digits: 2 })}</p>;
  }
  if (wallet.isError) return <p className={cn("num font-extrabold tracking-tight text-muted-foreground", className)}>—</p>;
  return <Skeleton className="mt-1 h-10 w-36" />;
}

function FundButtons({ className }: { className?: string }) {
  const { t } = useI18n();
  const { openDeposit, openWithdraw } = useWalletModals();
  return (
    <div className={cn("grid grid-cols-2 gap-3", className)}>
      <Button size="lg" className="h-12 text-base" onClick={openDeposit}>
        <Plus />
        {t("portfolio.deposit")}
      </Button>
      <Button size="lg" variant="secondary" className="h-12 text-base" onClick={openWithdraw}>
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
    <dl className="mt-3 grid gap-1.5 rounded-xl bg-raised/60 p-3 text-xs">
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
      <Button asChild size="xl" className="mt-5 w-full">
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
      <Icon className="size-8 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p className="mt-3 text-[0.9375rem] font-bold">{title}</p>
      <p className="mt-2 text-[0.8125rem] text-muted-foreground">{body}</p>
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
  if (overview.strategies.length === 0) return <EmptyCopying className={phone ? undefined : "mt-14 px-6"} />;
  if (phone) return <CopyCards strategies={overview.strategies} leaders={leaders} onSelect={select} sparklines={sparklines} />;
  const values = ["copying", "insights", "exposure"] as const;
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div role="tablist" aria-label={t("portfolio.title")} className="flex gap-6 border-b border-border px-4">
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
              "-mb-px flex items-center gap-1.5 border-b-2 py-3.5 text-[0.8125rem] font-semibold tracking-wide uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`portfolio.tabs.${value}`)}
            {value === "copying" ? <span className="num rounded bg-raised px-1.5 text-[11px] text-muted-foreground">{overview.strategies.length}</span> : null}
          </button>
        ))}
      </div>
      <div id="desktop-copy-panel" role="tabpanel" aria-labelledby={`desktop-copy-tab-${tab}`}>
        {tab === "copying" ? <CopyTable strategies={overview.strategies} leaders={leaders} onSelect={select} sparklines={sparklines} bare />
          : tab === "insights" ? <InsightsPanel overview={overview} leaders={leaders} onSelect={(id) => select(id)} desktop />
          : <ExposurePanel overview={overview} leaders={leaders} desktop />}
      </div>
    </section>
  );
}

function DesktopPortfolio() {
  const { t } = useI18n();
  const wallet = useWallet();
  const copy = useCopyOverview();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-stretch gap-4">
        <section className="w-[340px] rounded-2xl border border-border bg-card p-6" aria-label={t("portfolio.totalValue")}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[0.8125rem] text-muted-foreground">{t("portfolio.totalValue")}</p>
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
            <TotalValue wallet={wallet} className="text-[2.5rem] leading-tight" />
          </button>
          {open && wallet.data ? <Breakdown summary={wallet.data} /> : null}
          {wallet.isError && !wallet.data ? <ErrorState onRetry={() => wallet.refetch()} /> : null}
          <FundButtons className="mt-1" />
        </section>
        {copy.data ? <PaperSummary overview={copy.data} className="w-[340px]" /> : null}
        {copy.data && copy.data.strategies.length > 0 ? <PortfolioChart overview={copy.data} className="min-w-[420px] flex-1" /> : null}
      </div>
      {copy.data ? (
        <CopyingSection overview={copy.data} phone={false} />
      ) : copy.isError ? (
        <ErrorState onRetry={() => copy.refetch()} />
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </div>
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
    <div className="-mx-5 -mt-5">
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
      <header className="flex items-center justify-between px-5 pt-4">
        <p role="heading" aria-level={1} className="text-[1.75rem] font-extrabold tracking-tight">{t("portfolio.title")}</p>
        <div className="flex items-center gap-1">
          {/* CopyDog: the bell opens the Activity panel (copies, following, deposits). */}
          <button
            type="button"
            onClick={() => setActivity(true)}
            aria-label={t("feed.title")}
            className="flex size-10 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bell className="size-[22px]" />
          </button>
          <ActivityPanel open={activity} onClose={() => setActivity(false)} />
          <Link
            href="/settings"
            aria-label={t("portfolio.settings")}
            className="flex size-10 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings className="size-[22px]" />
          </Link>
        </div>
      </header>
  );
}

function PhoneSignedOut() {
  const { t } = useI18n();
  const { status, login } = useAuth();
  return (
    <div className="-mx-5 -mt-5">
      <PhoneHeader />
      <div className="flex flex-col items-center px-6 pt-14 text-center">
        <ChartPie className="size-10 text-muted-foreground" strokeWidth={1.5} aria-hidden />
        <p className="mt-4 text-base font-semibold">{t("portfolio.signInTitlePhone")}</p>
        <p className="mt-3 text-sm text-muted-foreground">{t("portfolio.signInBodyPhone")}</p>
        <Button size="lg" className="mt-3 h-[52px] px-6 text-[15px] font-semibold" onClick={login} disabled={status === "disabled"}>
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
      <div className="px-5 pt-3">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">{t("portfolio.totalValue")}</p>
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
          <TotalValue wallet={wallet} className="text-[2.25rem] leading-tight" />
          <ChevronDown className={cn("size-5 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        {open && wallet.data ? <Breakdown summary={wallet.data} /> : null}
        <FundButtons className="mt-3" />
      </div>

      <div className="mt-4 border-t border-border px-5 pt-4">
        <div role="tablist" aria-label={t("portfolio.title")} className="flex gap-2">
          {tabs.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "h-10 rounded-full px-4 text-[0.9375rem] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                tab === item.value ? "bg-primary text-primary-foreground" : "bg-raised text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={copy.data?.strategies.length ? "pt-4 pb-6" : "pt-8"}>
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
    return copy.isError ? <ErrorState onRetry={() => copy.refetch()} /> : <Skeleton className="h-40 w-full" />;
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
