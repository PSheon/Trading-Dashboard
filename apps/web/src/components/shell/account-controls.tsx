"use client";

import { Briefcase, Check, ChevronDown, ChevronRight, Globe, LogOut, Moon, Settings, ShieldCheck, Sun } from "lucide-react";
import { cn } from "cn";
import { useState } from "react";
import { Dialog, Popover, RadioGroup } from "radix-ui";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { LOCALE_NAMES } from "@/i18n/config";
import { Link } from "@/i18n/navigation";

import { Skeleton } from "@/components/page";
import { CopyEquityProbes, useCopiesEquity } from "@/lib/copy-equity";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import { useAuth, useIsAdmin, useMe } from "@/lib/auth";
import { API_FIXTURES } from "@/lib/config";
import { LanguageMenu } from "./language-menu";
import { ThemeToggle } from "./theme-toggle";
import { useTheme } from "@/lib/use-theme";
import { useCopyOverview } from "@/lib/copy";
import { useTradingMode, type SiteMode } from "@/lib/site-mode";
import { useWallet } from "@/lib/wallet";
import { useLogout } from "@/lib/use-logout";
import { OrbitSpinner } from "@/components/ui/orbit-spinner";

/** Header right (Orbit): signed out → language, theme and 登入; signed in →
 * the account pill (avatar menu, total value, 儲值). Plus the demo badge in
 * fixture mode. */
export function AccountControls() {
  const { t } = useI18n();
  const { status } = useAuth();
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      {API_FIXTURES ? (
        <span className="hidden rounded-full border-2 border-dashed border-input px-2.5 py-1 text-[0.6875rem] font-bold text-muted-foreground 2xl:inline">
          {t("topbar.fixtureBadge")}
        </span>
      ) : null}
      {status === "signedIn" ? (
        <AccountPill />
      ) : (
        <>
          <LocaleMenu />
          <ThemeToggle className="hidden lg:flex" />
          <AuthButton />
        </>
      )}
    </div>
  );
}

function LocaleMenu() {
  const { t } = useI18n();
  return (
    <LanguageMenu
      trigger={
        <Button variant="secondary" size="icon-header" aria-label={t("topbar.language")}>
          <Globe className="size-[18px]" strokeWidth={2.4} />
        </Button>
      }
    />
  );
}

/** 登入 while signed out; signed in, the avatar and its menu. `compact` is
 * the phone header's smaller size. */
export function AuthButton({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { status, mode, login } = useAuth();

  if (status === "disabled") {
    return (
      <Tooltip content={t("topbar.loginUnavailable")}>
        <span tabIndex={0} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Button disabled size={compact ? "default" : "header"}>
            {t("topbar.login")}
          </Button>
        </span>
      </Tooltip>
    );
  }

  if (status === "loading") {
    return <Skeleton className={cn("rounded-full", compact ? "h-11 w-20" : "h-[52px] w-28")} />;
  }

  if (status !== "signedIn") {
    return (
      <Button size={compact ? "default" : "header"} onClick={login}>
        {mode === "fixture" ? t("topbar.fixtureLogin") : t("topbar.login")}
      </Button>
    );
  }

  return <AccountMenu />;
}

function Initial({ label }: { label: string }) {
  return (
    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-tag-alert font-display text-base text-tag-alert-foreground">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The avatar (and, in the pill, the total value) opening the account menu. */
function AccountMenu({ children }: { children?: React.ReactNode }) {
  const { t, locale } = useI18n();
  const { identity } = useAuth();
  const trading = useTradingMode();
  const { logout, pending: leaving } = useLogout();
  const { data: me } = useMe();
  const isAdmin = useIsAdmin();
  const { theme, toggle } = useTheme();
  const desktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const label = me?.displayName || me?.email?.split("@")[0] || identity || t("topbar.account");
  const actual: SiteMode = trading.deploymentNetwork === "mainnet" ? "live" : "testnet";
  const row = "flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-sm font-bold outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring";
  const trigger = (
    <button type="button" aria-label={t("topbar.account")} className="orbit-press flex h-11 shrink-0 items-center gap-2 rounded-full p-0.5 pr-3 font-extrabold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring">
      <Initial label={label} />
      <span className="text-xs" data-mode={trading.mode}>{t(`mode.${trading.mode}`)}</span>
      <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
    </button>
  );
  const body = (
    <div data-testid="account-menu-card">
      <div className="flex items-center gap-3 px-3 pt-2 pb-4">
        <Initial label={label} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-lg font-bold">{label}</p>
          <p className="truncate text-xs text-muted-foreground">{me?.email || identity}</p>
        </div>
      </div>
      {children ? <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-raised px-4 py-3"><span className="text-xs font-bold text-muted-foreground">{t("portfolio.totalValue")}</span>{children}</div> : null}
      <RadioGroup.Root aria-label={t("mode.label")} value={trading.mode} orientation="horizontal" onValueChange={value => { trading.select(value as SiteMode); }} className="grid grid-cols-2 gap-1 rounded-full bg-raised p-1">
        {([actual, "paper"] as const).map(mode => (
          <RadioGroup.Item key={mode} value={mode} disabled={trading.pending > 0 || !trading.supports(mode)} className="flex min-h-11 items-center justify-center gap-2 rounded-full px-3 text-sm font-extrabold outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground">
            <RadioGroup.Indicator><Check className="size-4" aria-hidden /></RadioGroup.Indicator>
            {t(`mode.${mode}`)}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      {trading.pending > 0 ? <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">{t("mode.busy")}</p> : !trading.available || !trading.supports(actual) ? <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">{t("mode.unavailable")}</p> : null}
      <div className="my-3 h-px bg-border" />
      <Link href="/portfolio" onClick={() => setOpen(false)} className={row}><Briefcase className="size-[18px]" aria-hidden />{t("nav.portfolio")}<ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden /></Link>
      <Link href="/settings" onClick={() => setOpen(false)} className={row}><Settings className="size-[18px]" aria-hidden />{t("nav.settings")}<ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden /></Link>
      {isAdmin ? <Link href="/admin" onClick={() => setOpen(false)} className={row}><ShieldCheck className="size-[18px]" aria-hidden />{t("nav.admin")}<ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden /></Link> : null}
      <LanguageMenu trigger={<button type="button" className={row}><Globe className="size-[18px]" aria-hidden />{t("topbar.language")}<span className="ml-auto text-xs font-medium text-muted-foreground">{LOCALE_NAMES[locale]}</span><ChevronRight className="size-4 text-muted-foreground" aria-hidden /></button>} />
      <button type="button" onClick={toggle} aria-label={t("theme.switchTo", { theme: theme === "dark" ? t("theme.light") : t("theme.dark") })} className={row}>{theme === "dark" ? <Moon className="size-[18px]" aria-hidden /> : <Sun className="size-[18px]" aria-hidden />}{t("theme.label")}<span className="ml-auto text-xs font-medium text-muted-foreground">{t(theme === "dark" ? "theme.dark" : "theme.light")}</span></button>
      <div className="my-3 h-px bg-border" />
      <button type="button" disabled={leaving} aria-busy={leaving || undefined} onClick={() => { void logout(); }} className={cn(row, "text-muted-foreground disabled:opacity-50")}>{leaving ? <OrbitSpinner /> : <LogOut className="size-[18px]" aria-hidden />}{t("topbar.logout")}</button>
    </div>
  );
  if (desktop === false) return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]" />
        <Dialog.Content aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-3xl bg-background px-5 pt-4 pb-[calc(24px+env(safe-area-inset-bottom))] shadow-[var(--shadow-pop)] outline-none">
          <div className="mb-2 flex items-center justify-between"><Dialog.Title className="text-sm font-bold text-muted-foreground">{t("topbar.account")}</Dialog.Title><Dialog.Close className="flex min-h-11 items-center rounded-full bg-raised px-4 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("settings.close")}</Dialog.Close></div>
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal><Popover.Content aria-label={t("topbar.account")} align="end" sideOffset={10} collisionPadding={12} className="z-50 max-h-[calc(100dvh-100px)] w-[320px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-3xl bg-popover p-3 text-popover-foreground shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)] outline-none">{body}</Popover.Content></Popover.Portal>
    </Popover.Root>
  );
}

/** Orbit's signed-in pill: the avatar and total value open the account
 * menu; 儲值 opens the deposit modal. The value is 我的資金's: the main
 * account's /me/wallet total and this network's copies (shown from 1024px). */
function AccountPill() {
  const { t, format } = useI18n();
  const trading = useTradingMode();
  const paper = useCopyOverview();
  const wallet = useWallet();
  const total = trading.mode === "paper" ? paper.data?.paper.totalValue : trading.available && wallet.data && wallet.data.network === trading.deploymentNetwork ? wallet.data.totalValue : undefined;
  const inCopies = useCopiesEquity();
  const { openDeposit } = useWalletModals();
  return (
    <div className="flex h-[52px] items-center gap-1 rounded-[26px] bg-raised p-1">
      {trading.mode !== "paper" && trading.available ? <CopyEquityProbes /> : null}
      <AccountMenu>
        <span className="flex items-center gap-1.5">
          {total != null && (trading.mode === "paper" || inCopies !== null) ? (
            <span className="num font-display text-[15px]" data-testid="account-total">{format.usd(total + (trading.mode === "paper" ? 0 : inCopies!), { digits: 2 })}</span>
          ) : !trading.available || (trading.mode === "paper" ? paper.isError : wallet.isError || inCopies === null) ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <Skeleton className="h-4 w-16" />
          )}
        </span>
      </AccountMenu>
      {trading.mode !== "paper" && trading.available ? <Button onClick={openDeposit}>
        {t("portfolio.deposit")}
      </Button> : null}
    </div>
  );
}
