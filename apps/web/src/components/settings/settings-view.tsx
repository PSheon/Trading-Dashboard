"use client";

import {
  ArrowLeft,
  ArrowUp,
  Bell,
  ChevronDown,
  ChevronRight,
  Globe,
  Gift,
  RotateCcwClock as History,
  MessageCircle,
  Plus,
  ReceiptText,
  Settings,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";

import { useIsDesktop } from "@/lib/use-is-desktop";
import { useModalFocus } from "@/lib/use-modal-focus";
import { cn } from "cn";

import { ThemeChoiceControl } from "@/components/shell/theme-toggle";

import { Wordmark } from "@/components/brand/logo";
import { SkelBar } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shortAddress } from "@/components/wallet/bits";
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
import { ExecutionWalletSettings } from "./execution-wallets";

type Tab = "account" | "funds" | "referral";
type PhoneView = "root" | "account" | "notifications" | "language" | "history" | "referral";

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
 * - phone: a full-screen sheet (account row, 一般: 通知 / 語言 / 交易紀錄,
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
      {/* The phone sheet exists signed out too (登入 on top, only 語言). */}
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
    <div className="orbit-card mx-auto mt-10 flex w-full max-w-[460px] flex-col items-center px-8 py-10 text-center md:mt-[120px]">
      <span className="flex size-24 items-center justify-center rounded-full bg-raised"><Settings className="size-11 text-primary-text" strokeWidth={2} aria-hidden /></span>
      <h1 className="mt-4 font-display text-[2rem] leading-tight">{t("settings.signInTitle")}</h1>
      <p className="mt-2 text-sm leading-5 font-bold text-muted-foreground">{t("settings.signInBody")}</p>
      <Button size="xl" className="mt-6 w-[200px] font-semibold" onClick={login} disabled={status === "disabled"}>
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
  return <h3 className={cn("pb-1 font-display text-xl", className)}>{children}</h3>;
}

/** One white settings card (C-Settings). */
function SettingsCard({ children, className, danger = false }: { children: React.ReactNode; className?: string; danger?: boolean }) {
  return <div className={cn("orbit-card px-6 py-5", danger && "shadow-[0_0_0_2px_var(--tag-loss)]", className)}>{children}</div>;
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("settings.language")}
          className="flex h-11 w-[160px] items-center justify-between gap-2 rounded-full bg-inset pr-3.5 pl-4 text-sm font-extrabold outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          {LOCALE_NAMES[locale]}
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[150px]">
        <DropdownMenuRadioGroup value={locale} onValueChange={(v) => isLocale(v) && changeLocale(v)}>
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              {LOCALE_NAMES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
            <span className="font-mono">{shortAddress(address)}</span>
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
    <div className="flex flex-wrap items-end justify-between gap-4 orbit-card p-5">
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
      <h1 className="font-display text-[2.5rem] leading-[1.1]">{t("settings.title")}</h1>
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
                  <h2 className="truncate font-display text-[1.375rem]">{name}</h2>
                </div>
                <ProfileAndWallet />
              </SettingsCard>
              <ExecutionWalletSettings />
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
                <h2 className="mb-1 font-display text-xl">{t("wallet.historyTitle")}</h2>
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

function PhoneRow({ icon: Icon, label, value, onClick }: { icon: LucideIcon; label: string; value?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[56px] w-full items-center gap-4 border-b-2 border-dotted border-border text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="size-5" strokeWidth={2.4} />
      <span className="flex-1 text-base font-extrabold">{label}</span>
      {value ? <span className="text-[15px] font-bold text-muted-foreground">{value}</span> : null}
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
}

function PhoneSettings({ signedIn }: { signedIn: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { logout, login, status, mode } = useAuth();
  const { initial, email, name } = useAccountName();
  const [view, setView] = useQueryParam<PhoneView>(
    "view",
    signedIn ? mode === "privy" ? ["root", "account", "notifications", "language", "history", "referral"] : ["root", "account", "notifications", "language", "history"] : ["root", "language"],
    "root",
  );

  // A sub-view opened from the list is one history entry, and ← takes that
  // entry back rather than adding a third: otherwise × (which goes back)
  // returned to the sub-view just left, and the two buttons looped. A
  // sub-view opened by its URL has no entry of ours: ← replaces it.
  const opened = useRef(0);
  const open = (next: PhoneView) => {
    opened.current += 1;
    setView(next);
  };
  const back = () => {
    if (opened.current > 0) {
      opened.current -= 1;
      router.back();
    } else setView("root", "replace");
  };
  const close = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/portfolio");
  };
  // The panel covers the whole screen on a phone (it is not shown on
  // desktop): focus stays in it, and Escape is × on the list, ← in a sub-view.
  const phone = useIsDesktop() === false;
  const focusRef = useModalFocus<HTMLDivElement>(phone, () => (view === "root" ? close() : back()));

  return (
    <div ref={focusRef} role="dialog" aria-modal="true" aria-label={t("settings.title")} className="fixed inset-0 z-50 overflow-y-auto bg-background px-5 pt-4 pb-[calc(32px+env(safe-area-inset-bottom))]">
      {view === "root" ? (
        <>
          <button
            type="button"
            onClick={close}
            aria-label={t("settings.close")}
            className="flex size-10 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-5" />
          </button>
          {signedIn ? (
            <button
              type="button"
              onClick={() => open("account")}
              className="mt-6 flex w-full items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar initial={initial} size={52} />
              <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold">{email ?? name}</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          ) : (
            <>
              <div className="mt-6 flex items-center gap-3">
                <span className="flex size-[52px] shrink-0 items-center justify-center rounded-full bg-raised" aria-hidden>
                  <User className="size-5" />
                </span>
                <div className="min-w-0">
                  <p role="heading" aria-level={1} className="text-base leading-6 font-semibold">{t("settings.signInTitle")}</p>
                  <p className="mt-[3px] text-xs leading-[18px] text-muted-foreground">{t("settings.signInBody")}</p>
                </div>
              </div>
              <Button size="xl" className="mt-6 w-full" onClick={login} disabled={status === "disabled"}>
                {t("common.signIn")}
              </Button>
            </>
          )}

          <p className="mt-[22px] text-xs leading-[18px] font-bold text-muted-foreground">{t("settings.general")}</p>
          <div className="mt-1 orbit-card px-4">
            {signedIn ? <PhoneRow icon={Bell} label={t("settings.notifications")} onClick={() => open("notifications")} /> : null}
            <PhoneRow icon={Globe} label={t("settings.language")} value={LOCALE_NAMES[locale]} onClick={() => open("language")} />
            {signedIn ? <PhoneRow icon={History} label={t("settings.history")} onClick={() => open("history")} /> : null}
            {signedIn && mode === "privy" ? <PhoneRow icon={Gift} label={t("referral.title")} onClick={() => open("referral")} /> : null}
          </div>

          <p className="mt-[22px] mb-2 text-xs leading-[18px] font-bold text-muted-foreground">{t("theme.label")}</p>
          <ThemeChoiceControl />

          <div className="mt-6 flex items-center gap-4 orbit-card p-5">
            <div className="min-w-0 flex-1">
              <p className="font-display text-xl leading-6">{t("settings.feedbackTitle")}</p>
              <p className="mt-2 text-sm leading-[21px] text-muted-foreground">{t("settings.feedbackBody")}</p>
              <Button asChild size="sm" className="mt-4 h-[37px] px-3.5 text-sm font-semibold">
                <a href="https://t.me/orbie_fun_bot" target="_blank" rel="noreferrer">
                  {t("settings.feedbackCta")}
                </a>
              </Button>
            </div>
            <MessageCircle className="size-9 shrink-0 fill-primary text-primary-text" aria-hidden />
          </div>

          {signedIn ? (
          <button
            type="button"
            onClick={() => void logout()}
            className="orbit-press mt-6 h-[52px] w-full rounded-full bg-tag-loss text-[0.9375rem] font-extrabold text-tag-loss-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("settings.logout")}
          </button>
          ) : null}

          <div className="mt-10 flex flex-col items-center gap-3 text-xs leading-[18px] text-subtle-foreground">
            <Wordmark className="text-[1.75rem] text-subtle-foreground" />
            <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
              {t("settings.privacy")}
            </Link>
            <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
              {t("settings.terms")}
            </Link>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={back}
              aria-label={t("settings.back")}
              className="flex size-10 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft className="size-5" />
            </button>
            <h1 className="text-lg font-bold">
              {view === "account"
                ? t("settings.menu.account")
                : view === "notifications"
                  ? t("settings.notifications")
                  : view === "language"
                    ? t("settings.language")
                    : view === "referral" ? t("referral.title") : t("settings.history")}
            </h1>
          </div>
          <div className="mt-2">
            {view === "account" ? (
              <>
                <div className="flex items-center gap-3 pt-4">
                  <Avatar initial={initial} />
                  <p className="truncate text-lg font-bold">{name}</p>
                </div>
                <ProfileAndWallet />
                <ExecutionWalletSettings />
                <DeleteAccountButton className="mt-10" />
              </>
            ) : view === "notifications" ? (
              <div className="pt-3">
                <TradingBotRow className="border-b-2 border-dotted border-border" />
                <AlertBotRow />
              </div>
            ) : view === "referral" ? <ReferralSettings /> : view === "language" ? (
              <LanguageList />
            ) : (
              <div className="flex flex-col gap-5 pt-4">
                <FundsSummary />
                <FundsHistory />
              </div>
            )}
          </div>
        </>
      )}
    </div>
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
