"use client";

import {
  ArrowLeft,
  ArrowUp,
  Bell,
  ChevronDown,
  ChevronRight,
  Globe,
  RotateCcwClock as History,
  MessageCircle,
  Plus,
  ReceiptText,
  Settings,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { cn } from "cn";

import { Wordmark } from "@/components/brand/logo";
import { Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { shortAddress } from "@/components/wallet/bits";
import { WalletHistoryList } from "@/components/wallet/history-list";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { LOCALES, isLocale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useAuth, useMe } from "@/lib/auth";
import { useChangeLocale } from "@/lib/use-change-locale";
import { useWallet, useWalletAddress } from "@/lib/wallet";
import { AlertBotRow, TradingBotRow } from "./bot-rows";
import { DeleteAccountButton, DeleteAccountDialog } from "./delete-account";

type Tab = "account" | "funds";
type PhoneView = "root" | "account" | "notifications" | "language" | "history";

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
  if (status === "loading") return <SettingsSkeleton />;
  const signedIn = status === "signedIn";
  return (
    <>
      <div className="hidden md:block">{signedIn ? <DesktopSettings /> : <SignedOut />}</div>
      {/* The phone sheet exists signed out too (登入 on top, only 語言). */}
      <div className="md:hidden">
        <PhoneSettings signedIn={signedIn} />
      </div>
    </>
  );
}

function SignedOut() {
  const { t } = useI18n();
  const { status, login } = useAuth();
  return (
    <div className="flex flex-col items-center px-6 pt-10 text-center md:pt-12">
      <Settings className="size-11 text-subtle-foreground" strokeWidth={1.5} aria-hidden />
      <h1 className="mt-5 text-xl font-bold tracking-tight">{t("settings.signInTitle")}</h1>
      <p className="mt-2.5 text-sm text-muted-foreground">{t("settings.signInBody")}</p>
      <Button size="xl" className="mt-7 w-[200px]" onClick={login} disabled={status === "disabled"}>
        {t("common.signIn")}
      </Button>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton className="h-8 w-24" />
      <div className="grid gap-6 md:grid-cols-[360px_1fr]">
        <div className="hidden flex-col gap-2 md:flex">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-12 w-60" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}

// --- shared pieces -------------------------------------------------------------

function Avatar({ initial, size = 44 }: { initial: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-raised font-semibold text-foreground"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("pt-6 pb-1 text-[0.9375rem] font-bold", className)}>{children}</h3>;
}

function Row({ label, value, action, className }: { label: string; value?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-4 py-3.5", className)}>
      <div className="min-w-0 flex-1">
        <p className="text-[0.8125rem] font-semibold">{label}</p>
        {value !== undefined ? <div className="mt-1 truncate text-xs text-muted-foreground">{value}</div> : null}
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
          className="flex h-9 w-[150px] items-center justify-between gap-2 rounded-full bg-raised pr-3 pl-3.5 text-[0.8125rem] font-semibold outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(`locales.${locale}`)}
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[150px]">
        <DropdownMenuRadioGroup value={locale} onValueChange={(v) => isLocale(v) && changeLocale(v)}>
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              {t(`locales.${l}`)}
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
      <SectionTitle>{t("settings.profile")}</SectionTitle>
      <Row label={t("settings.email")} value={email ?? t("settings.noEmail")} className="border-b border-border" />
      <Row
        label={t("settings.wallet")}
        value={
          address ? (
            <span className="font-mono">{shortAddress(address)}</span>
          ) : wallet.isPending ? (
            <Skeleton className="h-3.5 w-28" />
          ) : (
            t("settings.walletPending")
          )
        }
        action={
          <Button variant="secondary" size="sm" className="h-9 px-3.5 text-muted-foreground" onClick={openExport} disabled={!address}>
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
    <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-border bg-card p-5">
      <div>
        <p className="text-xs text-muted-foreground">{t("portfolio.totalValue")}</p>
        {wallet.data ? (
          <p className="num mt-1 text-3xl font-extrabold tracking-tight">{format.usd(wallet.data.totalValue, { digits: 2 })}</p>
        ) : (
          <Skeleton className="mt-2 h-8 w-32" />
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

function useQueryParam<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get(key);
  const value = allowed.includes(raw as T) ? (raw as T) : fallback;
  const set = (next: T) => {
    const qs = new URLSearchParams(params.toString());
    if (next === fallback) qs.delete(key);
    else qs.set(key, next);
    const query = qs.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
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
        "flex h-[62px] w-full items-center gap-3.5 px-6 text-left text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active ? "bg-raised" : "hover:bg-raised/60",
      )}
    >
      <Icon className="size-5" strokeWidth={1.75} />
      <span className="flex-1">{label}</span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
}

function DesktopSettings() {
  const { t } = useI18n();
  const [tab, setTab] = useQueryParam<Tab>("tab", ["account", "funds"], "account");
  const { name, initial } = useAccountName();

  return (
    // Flush against the icon rail, as on CopyDog (the menu starts at the rail).
    <div className="-mt-2 -ml-8">
      <h1 className="pb-6 pl-4 text-xl font-bold tracking-tight">{t("settings.title")}</h1>
      <div className="grid min-h-[calc(100dvh-200px)] grid-cols-[300px_1fr] border-t border-border lg:grid-cols-[360px_1fr]">
        <nav aria-label={t("settings.title")} className="border-r border-border">
          <MenuItem icon={User} label={t("settings.menu.account")} active={tab === "account"} onClick={() => setTab("account")} />
          <MenuItem icon={ReceiptText} label={t("settings.menu.funds")} active={tab === "funds"} onClick={() => setTab("funds")} />
        </nav>
        <section className="min-w-0 pl-7" aria-label={tab === "account" ? t("settings.menu.account") : t("settings.menu.funds")}>
          {tab === "account" ? (
            <>
              <div className="flex items-center gap-3.5 pt-5 pb-1">
                <Avatar initial={initial} />
                <h2 className="truncate text-xl font-bold tracking-tight">{name}</h2>
              </div>
              <ProfileAndWallet />
              <SectionTitle className="pt-8">{t("settings.language")}</SectionTitle>
              <Row label={t("settings.language")} value={t("settings.languageHint")} action={<LanguageSelect />} />
              <SectionTitle className="pt-8">{t("settings.notifications")}</SectionTitle>
              <TradingBotRow className="border-b border-border" />
              <AlertBotRow />
              <DesktopDeleteRow />
            </>
          ) : (
            <div className="flex flex-col gap-5 pt-5">
              <FundsSummary />
              <div>
                <h2 className="text-[0.9375rem] font-bold">{t("wallet.historyTitle")}</h2>
                <WalletHistoryList className="mt-2" />
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
    <>
      <SectionTitle className="pt-8">{t("deleteAccount.title")}</SectionTitle>
      <Row
        label={t("deleteAccount.cta")}
        value={t("deleteAccount.rowHint")}
        action={
          <Button variant="destructive" size="sm" className="h-9 px-3.5" onClick={() => setOpen(true)}>
            {t("deleteAccount.cta")}
          </Button>
        }
      />
      <DeleteAccountDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

// --- phone -----------------------------------------------------------------------

function PhoneRow({ icon: Icon, label, value, onClick }: { icon: LucideIcon; label: string; value?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[54px] w-full items-center gap-4 border-b border-border text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="size-5" strokeWidth={1.75} />
      <span className="flex-1 text-base font-semibold">{label}</span>
      {value ? <span className="text-sm text-muted-foreground">{value}</span> : null}
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
}

function PhoneSettings({ signedIn }: { signedIn: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { logout, login, status } = useAuth();
  const { initial, email, name } = useAccountName();
  const [view, setView] = useQueryParam<PhoneView>(
    "view",
    signedIn ? ["root", "account", "notifications", "language", "history"] : ["root", "language"],
    "root",
  );

  const close = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/portfolio");
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background px-5 pt-4 pb-[calc(32px+env(safe-area-inset-bottom))]">
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
              onClick={() => setView("account")}
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
                  <p className="text-[0.9375rem] font-bold">{t("settings.signInTitle")}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.signInBody")}</p>
                </div>
              </div>
              <Button size="xl" className="mt-6 w-full" onClick={login} disabled={status === "disabled"}>
                {t("common.signIn")}
              </Button>
            </>
          )}

          <p className="mt-7 text-xs text-muted-foreground">{t("settings.general")}</p>
          <div className="mt-1">
            {signedIn ? <PhoneRow icon={Bell} label={t("settings.notifications")} onClick={() => setView("notifications")} /> : null}
            <PhoneRow icon={Globe} label={t("settings.language")} value={t(`locales.${locale}`)} onClick={() => setView("language")} />
            {signedIn ? <PhoneRow icon={History} label={t("settings.history")} onClick={() => setView("history")} /> : null}
          </div>

          <div className="mt-8 flex items-center gap-4 rounded-2xl bg-card p-5">
            <div className="min-w-0 flex-1">
              <p className="text-xl font-bold tracking-tight">{t("settings.feedbackTitle")}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("settings.feedbackBody")}</p>
              <Button asChild size="sm" className="mt-4 h-9 px-4">
                <a href="https://t.me/orbie_fun_bot" target="_blank" rel="noreferrer">
                  {t("settings.feedbackCta")}
                </a>
              </Button>
            </div>
            <MessageCircle className="size-9 shrink-0 fill-primary text-primary" aria-hidden />
          </div>

          {signedIn ? (
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-6 h-[52px] w-full rounded-xl bg-card text-[0.9375rem] font-semibold text-negative outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("settings.logout")}
          </button>
          ) : null}

          <div className="mt-12 flex flex-col items-center gap-3 text-xs text-subtle-foreground">
            <Wordmark className="text-[1.75rem] text-subtle-foreground" />
            <Tooltip content={t("common.comingSoon")}>
              <span tabIndex={0} className="underline underline-offset-2">
                {t("settings.privacy")}
              </span>
            </Tooltip>
            <Tooltip content={t("common.comingSoon")}>
              <span tabIndex={0} className="underline underline-offset-2">
                {t("settings.terms")}
              </span>
            </Tooltip>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setView("root")}
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
                    : t("settings.history")}
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
                <DeleteAccountButton className="mt-10" />
              </>
            ) : view === "notifications" ? (
              <div className="pt-3">
                <TradingBotRow className="border-b border-border" />
                <AlertBotRow />
              </div>
            ) : view === "language" ? (
              <LanguageList />
            ) : (
              <div className="flex flex-col gap-5 pt-4">
                <FundsSummary />
                <WalletHistoryList />
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
          className="flex h-[54px] w-full items-center border-b border-border text-left text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex-1">{t(`locales.${l}`)}</span>
          {l === locale ? <span className="size-2.5 rounded-full bg-primary" /> : null}
        </button>
      ))}
    </div>
  );
}

