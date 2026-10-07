"use client";

import {
  ArrowLeft,
  ArrowUp,
  Bell,
  ChevronRight,
  Globe,
  Gift,
  RotateCcwClock as History,
  MessageCircle,
  Plus,
  ReceiptText,
  Settings,
  User,
  SunMoon,
  ShieldCheck,
  ScrollText,
  LogOut,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";

import { X_URL } from "@/lib/config";
import { cn } from "cn";

import { ThemeChoiceControl } from "@/components/shell/theme-toggle";

import { DataList } from "@/components/ui/data-list";
import { SwitchPanel } from "@/components/ui/switch-panel";
import { SkelBar } from "@/components/page";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

import { FundsHistory } from "@/components/wallet/funds-history";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { LOCALE_NAMES, LOCALES, isLocale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useAuth, useMe } from "@/lib/auth";
import { useChangeLocale } from "@/lib/use-change-locale";
import { useWallet, useWalletAddress } from "@/lib/wallet";
import { AlertBotRow, TradingBotRow } from "./bot-rows";
import { DeleteAccountButton, DeleteAccountDialog } from "./delete-account";
import { ReferralSettings } from "./referral";
import { CopyWalletsList } from "./copy-wallets";
import { useLogout } from "@/lib/use-logout";
import { OrbitSpinner } from "@/components/ui/orbit-spinner";
import { truncateAddress } from "@/lib/format";

type Tab = "account" | "funds" | "referral";
type PhoneView = "root" | "account" | "notifications" | "language" | "history" | "referral" | "theme";

/** The name CopyDog shows: the display name, else the email's local part. */
function useAccountName(): { name: string; initial: string; email: string | null } {
  const { data: me } = useMe();
  const { identity } = useAuth();
  const email = me?.email ?? identity ?? null;
  const name = me?.displayName || email?.split("@")[0] || "—";
  return { name, initial: name.slice(0, 1).toUpperCase(), email };
}

/**
 * 設定, as on CopyDog (`/hyperliquid/settings`):
 * - signed out: a gear, 登入以檢視設定 and 登入;
 * - desktop: title, a left menu (帳戶 / 儲值與提款, with chevrons) and the
 *   chosen panel; the tab lives in `?tab=`;
 * - phone: an ordinary page (account row, 一般: 通知 / 語言 / 交易紀錄,
 *   the feedback card, 登出, legal links) whose rows open sub-views
 *   (`?view=`). It is reached from the portfolio's gear, not the tab bar.
 */
export function SettingsView() {
  const { status } = useAuth();
  // While sign-in is unknown the signed-in page is drawn in its loading
  // state (its reads wait for the session), as a returning visitor sees it.
  const loading = status === "loading";
  const signedIn = status === "signedIn" || loading;
  return (
    <div aria-busy={loading || undefined} className="contents">
      <div className="hidden md:block">{signedIn ? <DesktopSettings /> : <SignedOut />}</div>
      {/* The phone page exists signed out too, with public preferences. */}
      <div className="md:hidden">
        <PhoneSettings signedIn={signedIn} />
      </div>
    </div>
  );
}

function SignedOut() {
  const { t } = useI18n();
  const { status, login } = useAuth();
  return (
    // CopyDog's settings shell spans the rail edge to 28px short of the
    // window (centre x=744 at 1440), narrower on the right than the page frame.
    <div className="orbit-card mx-auto mt-10 flex w-full max-w-[460px] flex-col items-center rounded-[32px]! px-8 py-10 text-center md:mt-[120px]">
      <span className="flex size-24 items-center justify-center rounded-full bg-raised"><Settings className="size-11 text-primary-text" strokeWidth={2} aria-hidden /></span>
      <h1 className="type-h1 mt-4">{t("settings.signInTitle")}</h1>
      <p className="mt-2 text-sm leading-5 font-bold text-muted-foreground">{t("settings.signInBody")}</p>
      <Button size="cta" className="mt-6 w-[200px]" onClick={login} disabled={status === "disabled"}>
        {t("common.signIn")}
      </Button>
    </div>
  );
}

// --- shared pieces -------------------------------------------------------------

function Avatar({ initial, size = 44 }: { initial: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-tag-alert font-display text-tag-alert-foreground"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("type-h2 pb-1", className)}>{children}</h3>;
}

/** One white settings card (C-Settings). */
function SettingsCard({ children, className, danger = false }: { children: React.ReactNode; className?: string; danger?: boolean }) {
  return <div className={cn("orbit-card card-pad", danger && "shadow-[0_0_0_2px_var(--tag-loss)]", className)}>{children}</div>;
}

function Row({ label, value, action, className }: { label: string; value?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-4 py-3.5", className)}>
      <div className="min-w-0 flex-1">
        <p className="text-[0.875rem] font-extrabold">{label}</p>
        {value !== undefined ? <div className="mt-1 truncate text-xs font-bold text-muted-foreground">{value}</div> : null}
      </div>
      {action}
    </div>
  );
}

function LanguageSelect() {
  const { t, locale } = useI18n();
  const changeLocale = useChangeLocale();
  return (
    <Select
      size="sm"
      align="end"
      label={t("settings.language")}
      value={locale}
      onValueChange={(v) => isLocale(v) && changeLocale(v)}
      className="w-[160px]"
      options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
    />
  );
}

/** 個人資料 + 錢包 (short address, 匯出錢包金鑰). */
function ProfileAndWallet() {
  const { t } = useI18n();
  const { email } = useAccountName();
  const address = useWalletAddress();
  const wallet = useWallet();
  const { openExport } = useWalletModals();
  return (
    <>
      <SectionTitle className="pt-3">{t("settings.profile")}</SectionTitle>
      <Row label={t("settings.email")} value={email ?? t("settings.noEmail")} className="border-b-2 border-dotted border-border" />
      <Row
        label={t("settings.wallet")}
        value={
          address ? (
            <span className="font-mono">{truncateAddress(address)}</span>
          ) : wallet.isPending ? (
            <SkelBar line="h-4" className="ui-skeleton h-2.5 w-28" />
          ) : (
            t("settings.walletPending")
          )
        }
        action={
          <Button variant="secondary" className="h-11 bg-inset px-5" onClick={() => openExport()} disabled={!address}>
            {t("settings.exportKey")}
          </Button>
        }
      />
    </>
  );
}

function FundsSummary() {
  const { t, format } = useI18n();
  const wallet = useWallet();
  const { openDeposit, openWithdraw } = useWalletModals();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 orbit-card card-pad">
      <div>
        <p className="text-xs text-muted-foreground">{t("portfolio.totalValue")}</p>
        {wallet.data ? (
          <p className="num mt-1 font-display text-[2.125rem] leading-[1.2]">{format.usd(wallet.data.totalValue, { digits: 2 })}</p>
        ) : (
          <p aria-hidden="true" className="num mt-1 flex h-[1.2em] items-center font-display text-[2.125rem]">
            <span className="ui-skeleton block h-[0.75em] w-[4.5em] rounded-full bg-raised" />
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button onClick={openDeposit}>
          <Plus />
          {t("portfolio.deposit")}
        </Button>
        <Button variant="secondary" onClick={openWithdraw}>
          <ArrowUp />
          {t("portfolio.withdraw")}
        </Button>
      </div>
    </div>
  );
}

// --- desktop -------------------------------------------------------------------

function useQueryParam<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (value: T, how?: "push" | "replace") => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get(key);
  const value = allowed.includes(raw as T) ? (raw as T) : fallback;
  const set = (next: T, how: "push" | "replace" = "push") => {
    const qs = new URLSearchParams(params.toString());
    if (next === fallback) qs.delete(key);
    else qs.set(key, next);
    const query = qs.toString();
    router[how](query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  return [value, set];
}

function MenuItem({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "orbit-press flex h-12 w-full items-center gap-3 rounded-full px-[18px] text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-primary font-extrabold text-primary-foreground" : "font-bold text-muted-foreground hover:bg-raised-hover hover:text-foreground",
      )}
    >
      <Icon className="size-[18px]" strokeWidth={2.4} />
      <span className="flex-1">{label}</span>
      <ChevronRight className="size-4 opacity-70" strokeWidth={2.4} />
    </button>
  );
}

function DesktopSettings() {
  const { t } = useI18n();
  const { mode } = useAuth();
  const [tab, setTab] = useQueryParam<Tab>("tab", mode === "privy" ? ["account", "funds", "referral"] : ["account", "funds"], "account");
  const { name, initial } = useAccountName();

  return (
    <div className="flex flex-col gap-5">
      <h1 className="type-h1">{t("settings.title")}</h1>
      <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-4 lg:grid-cols-[240px_minmax(0,760px)]">
        <nav aria-label={t("settings.title")} className="flex flex-col gap-1 rounded-2xl bg-raised p-2.5">
          <MenuItem icon={User} label={t("settings.menu.account")} active={tab === "account"} onClick={() => setTab("account")} />
          <MenuItem icon={ReceiptText} label={t("settings.menu.funds")} active={tab === "funds"} onClick={() => setTab("funds")} />
          {mode === "privy" ? <MenuItem icon={Gift} label={t("referral.title")} active={tab === "referral"} onClick={() => setTab("referral")} /> : null}
        </nav>
        <section className="flex min-w-0 flex-col gap-4" aria-label={tab === "account" ? t("settings.menu.account") : tab === "referral" ? t("referral.title") : t("settings.menu.funds")}>
          {tab === "account" ? (
            <>
              <SettingsCard>
                <div className="flex items-center gap-3.5 pb-2">
                  <Avatar initial={initial} />
                  <h2 className="type-h2 truncate">{name}</h2>
                </div>
                <ProfileAndWallet />
              </SettingsCard>
              <CopyWalletsList />
              <SettingsCard>
                <SectionTitle>{t("settings.language")}</SectionTitle>
                <Row label={t("settings.language")} value={t("settings.languageHint")} action={<LanguageSelect />} />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-dotted border-border pt-3.5 pb-1">
                  <p className="text-[0.875rem] font-extrabold">{t("theme.label")}</p>
                  <ThemeChoiceControl className="w-full max-w-[420px] [&_button]:bg-inset [&_button[aria-checked=true]]:bg-primary" />
                </div>
              </SettingsCard>
              <SettingsCard>
                <SectionTitle>{t("settings.notifications")}</SectionTitle>
                <TradingBotRow className="border-b-2 border-dotted border-border" />
                <AlertBotRow />
              </SettingsCard>
              <DesktopDeleteRow />
            </>
          ) : tab === "referral" ? <ReferralSettings /> : (
            <div className="flex flex-col gap-4">
              <FundsSummary />
              <div>
                <h2 className="type-h2 mb-1">{t("wallet.historyTitle")}</h2>
                <FundsHistory className="mt-2" />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Not on CopyDog's desktop settings (only its app has it); Orbie keeps a
 * way in on desktop too, below everything else. */
function DesktopDeleteRow() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <SettingsCard danger>
      <SectionTitle>{t("deleteAccount.title")}</SectionTitle>
      <Row
        label={t("deleteAccount.cta")}
        value={t("deleteAccount.rowHint")}
        action={
          <Button variant="destructive" className="h-11 px-5" onClick={() => setOpen(true)}>
            {t("deleteAccount.cta")}
          </Button>
        }
      />
      <DeleteAccountDialog open={open} onOpenChange={setOpen} />
    </SettingsCard>
  );
}

// --- phone -----------------------------------------------------------------------

const PHONE_VIEWS = ["root", "account", "notifications", "language", "history", "referral", "theme"] as const;

function PhoneRow({ icon: Icon, label, value, onClick, href, external = false, danger = false, secondary = false, busy = false }: {
  icon: LucideIcon; label: string; value?: string; onClick?: () => void; href?: string; external?: boolean; danger?: boolean; secondary?: boolean; busy?: boolean;
}) {
  const className = cn("orbit-press flex h-11 w-full min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", danger ? "text-negative" : secondary ? "text-muted-foreground" : "text-foreground");
  const content = <><Icon className="size-5 shrink-0" strokeWidth={2.4} aria-hidden /><span className="min-w-0 flex-1 truncate text-sm font-extrabold">{label}</span>{value ? <span className="max-w-[40%] truncate text-xs font-bold text-muted-foreground">{value}</span> : null}{busy ? <OrbitSpinner className="size-4" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}</>;
  if (href) return external ? <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{content}</a> : <Link href={href} className={className}>{content}</Link>;
  return <button type="button" className={className} onClick={onClick} disabled={busy} aria-busy={busy || undefined}>{content}</button>;
}

function PhoneSettings({ signedIn }: { signedIn: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { login, status, mode } = useAuth();
  const signOut = useLogout();
  const { initial, email, name } = useAccountName();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const allowed = signedIn ? PHONE_VIEWS.filter(v => v !== "referral" || mode === "privy") : ["root", "language", "theme"] as const;
  const [view, setView] = useQueryParam<PhoneView>("view", allowed, "root");
  const opened = useRef(0);
  const open = (next: PhoneView) => { opened.current += 1; setView(next); };
  const back = () => {
    if (view === "root") { router.push("/portfolio"); return; }
    if (opened.current > 0) { opened.current -= 1; router.back(); }
    else setView("root", "replace");
  };
  const titles = { root: "settings.title", account: "settings.menu.account", notifications: "settings.notifications", language: "settings.language", history: "settings.history", referral: "referral.title", theme: "theme.label" } as const;
  return (
    <section data-testid="phone-settings" aria-label={t("settings.title")} className="min-w-0 pb-6">
      <div className="mb-5 flex min-w-0 items-center gap-3">
        <button type="button" onClick={back} aria-label={t("settings.back")} className="orbit-press flex size-11 shrink-0 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft className="size-5" aria-hidden /></button>
        <h1 className="min-w-0 truncate font-display text-2xl">{t(titles[view])}</h1>
      </div>
      <SwitchPanel value={view} order={PHONE_VIEWS}>
        {view === "root" ? <div className="flex flex-col gap-4">
          {!signedIn ? <div className="orbit-card card-pad">
            <h2 className="type-h2">{t("settings.signInTitle")}</h2><p className="mt-2 text-sm text-muted-foreground">{t("settings.signInBody")}</p>
            <Button size="cta" className="mt-4 w-full" onClick={login} disabled={status === "disabled"}>{t("common.signIn")}</Button>
          </div> : null}
          <DataList as="div" className="orbit-card px-4 py-1">
            {signedIn ? <PhoneRow icon={User} label={t("settings.menu.account")} value={email ?? name} onClick={() => open("account")} /> : null}
            {signedIn ? <PhoneRow icon={Bell} label={t("settings.notifications")} onClick={() => open("notifications")} /> : null}
            <PhoneRow icon={Globe} label={t("settings.language")} value={LOCALE_NAMES[locale]} onClick={() => open("language")} />
            {signedIn ? <PhoneRow icon={History} label={t("settings.history")} onClick={() => open("history")} /> : null}
            {signedIn && mode === "privy" ? <PhoneRow icon={Gift} label={t("referral.title")} onClick={() => open("referral")} /> : null}
            <PhoneRow icon={SunMoon} label={t("theme.label")} onClick={() => open("theme")} />
          </DataList>
          <DataList as="div" className="orbit-card px-4 py-1">
            <PhoneRow icon={MessageCircle} label={t("settings.feedbackTitle")} href={X_URL} external />
            <PhoneRow icon={ShieldCheck} label={t("settings.privacy")} href="/privacy" />
            <PhoneRow icon={ScrollText} label={t("settings.terms")} href="/terms" />
          </DataList>
          {signedIn ? <DataList as="div" className="orbit-card px-4 py-1">
            <PhoneRow icon={LogOut} label={t("settings.logout")} secondary busy={signOut.pending} onClick={() => void signOut.logout()} />
            <PhoneRow icon={Trash2} label={t("deleteAccount.title")} danger onClick={() => setDeleteOpen(true)} />
          </DataList> : null}
        </div> : view === "account" ? <div className="flex flex-col gap-4">
          <SettingsCard><div className="flex min-w-0 items-center gap-3"><Avatar initial={initial} /><h2 className="truncate text-lg font-bold">{name}</h2></div><ProfileAndWallet /></SettingsCard>
          <CopyWalletsList /><DeleteAccountButton className="mt-6" />
        </div> : view === "notifications" ? <SettingsCard><TradingBotRow className="border-b-2 border-dotted border-border" /><AlertBotRow /></SettingsCard>
          : view === "referral" ? <ReferralSettings /> : view === "language" ? <SettingsCard><LanguageList /></SettingsCard>
          : view === "theme" ? <SettingsCard><ThemeChoiceControl /></SettingsCard>
          : <div className="flex flex-col gap-5"><FundsSummary /><FundsHistory /></div>}
      </SwitchPanel>
      <DeleteAccountDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
    </section>
  );
}

function LanguageList() {
  const { t, locale } = useI18n();
  const changeLocale = useChangeLocale();
  return (
    <div className="pt-3" role="radiogroup" aria-label={t("settings.language")}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={l === locale}
          onClick={() => changeLocale(l)}
          className="flex h-[54px] w-full items-center border-b-2 border-dotted border-border text-left text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex-1">{LOCALE_NAMES[l]}</span>
          {l === locale ? <span className="size-2.5 rounded-full bg-primary" /> : null}
        </button>
      ))}
    </div>
  );
}
