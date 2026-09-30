"use client";

import { ArrowUp, Bell, ChartPie, ChevronDown, Plus, Settings, ShoppingCart, UserPlus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "cn";

import { ErrorState, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { NetworkBadge } from "@/components/wallet/bits";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import type { WalletSummary } from "@/lib/contracts";
import { useWallet } from "@/lib/wallet";

type Tab = "copying" | "insights" | "exposure";

/**
 * 投資組合, as on CopyDog (`/hyperliquid/portfolio`):
 * - signed out: 登入以查看您的投資組合 and 登入;
 * - desktop: the 總價值 card (＋儲值 / ↑提款) over the copy list, which is
 *   empty (你尚未跟單任何交易員 + 尋找交易員) until copy trading ships;
 * - phone: its own header (title, bell, gear → settings), total value with
 *   a breakdown chevron, 儲值 / 提款, and Copying / Insights / Exposure tabs.
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
    </>
  );
}

function SignedOut() {
  const { t } = useI18n();
  const { status, login } = useAuth();
  return (
    <div className="flex flex-col items-center px-6 pt-16 text-center md:pt-24">
      <ShoppingCart className="size-14 text-subtle-foreground" strokeWidth={1.5} aria-hidden />
      <h1 className="mt-5 text-2xl font-bold tracking-tight md:text-[1.75rem]">{t("portfolio.signInTitle")}</h1>
      <p className="mt-3 text-[0.9375rem] text-muted-foreground">{t("portfolio.signInBody")}</p>
      <Button size="xl" className="mt-8 w-[200px]" onClick={login} disabled={status === "disabled"}>
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

function DesktopPortfolio() {
  const { t } = useI18n();
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
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
        {wallet.isError && !wallet.data ? <ErrorState message={wallet.error.message} onRetry={() => wallet.refetch()} /> : null}
        <FundButtons className="mt-1" />
      </section>
      <EmptyCopying className="mt-14 px-6" />
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
    <div className="-mx-4 -mt-5">
      <PhoneHeader />
      <PhoneBody tab={tab} setTab={setTab} tabs={tabs} wallet={wallet} open={open} setOpen={setOpen} />
    </div>
  );
}

/** 投資組合 with the bell (notification settings) and the gear: on phones
 * the gear is how settings are reached, as on CopyDog. */
function PhoneHeader() {
  const { t } = useI18n();
  return (
      <header className="flex items-center justify-between px-5 pt-4">
        <h1 className="text-[1.75rem] font-extrabold tracking-tight">{t("portfolio.title")}</h1>
        <div className="flex items-center gap-1">
          <Link
            href="/settings?view=notifications"
            aria-label={t("portfolio.notifications")}
            className="flex size-10 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bell className="size-[22px]" />
          </Link>
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
    <div className="-mx-4 -mt-5">
      <PhoneHeader />
      <div className="flex flex-col items-center px-6 pt-14 text-center">
        <ChartPie className="size-10 text-muted-foreground" strokeWidth={1.5} aria-hidden />
        <p className="mt-4 text-base font-bold">{t("portfolio.signInTitlePhone")}</p>
        <p className="mt-3 text-sm text-muted-foreground">{t("portfolio.signInBodyPhone")}</p>
        <Button size="lg" className="mt-6 px-6" onClick={login} disabled={status === "disabled"}>
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
        <div role="tabpanel" className="pt-8">
          {tab === "copying" ? (
            <EmptyCopying />
          ) : tab === "insights" ? (
            <TabEmpty icon={ChartPie} title={t("portfolio.insightsEmptyTitle")} body={t("portfolio.insightsEmptyBody")} />
          ) : (
            <TabEmpty icon={ChartPie} title={t("portfolio.exposureEmptyTitle")} body={t("portfolio.exposureEmptyBody")} />
          )}
        </div>
      </div>
    </>
  );
}
