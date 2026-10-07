"use client";

import { Briefcase, Check, ChevronDown, Globe, LogOut, Moon, Settings, ShieldCheck, Sun } from "lucide-react";
import { cn } from "cn";
import { Link } from "@/i18n/navigation";

import { Skeleton } from "@/components/page";
import { CopyEquityProbes, useCopiesEquity } from "@/lib/copy-equity";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  const { t } = useI18n();
  const { identity } = useAuth();
  const trading = useTradingMode();
  const mutating = trading.pending;
  const { logout, pending: leaving } = useLogout();
  const { data: me } = useMe();
  const isAdmin = useIsAdmin();
  const { theme, toggle } = useTheme();
  const label = me?.displayName || me?.email?.split("@")[0] || identity || t("topbar.account");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("topbar.account")}
          className="orbit-press flex h-11 shrink-0 items-center gap-2 rounded-full p-0.5 font-extrabold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-raised-hover"
        >
          <Initial label={label} />
          <span className="pr-1 text-xs font-extrabold" data-mode={trading.mode}>{t(`mode.${trading.mode}`)}</span>
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>
          <span className="block">{t("topbar.signedInAs")}</span>
          <span className="mt-0.5 block truncate text-sm font-medium text-foreground">
            {me?.email || identity || label}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("mode.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={trading.mode} onValueChange={(value) => {
          trading.select(value as SiteMode);
        }}>
          {(["live", "testnet", "paper"] as const).map(mode => (
            <DropdownMenuRadioItem key={mode} value={mode} disabled={mutating > 0 || !trading.supports(mode)} className="min-h-11">
              <span className="flex-1">
                <span className="block">{t(`mode.${mode}`)}</span>
                {!trading.supports(mode) ? <span className="block text-xs font-normal">{t("mode.unavailable")}</span> : null}
              </span>
              {trading.mode === mode ? <Check className="size-4" aria-hidden /> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {mutating > 0 ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("mode.busy")}</p> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/portfolio">
            <Briefcase />
            {t("nav.portfolio")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings />
            {t("nav.settings")}
          </Link>
        </DropdownMenuItem>
        {isAdmin ? (
          <DropdownMenuItem asChild>
            <Link href="/admin">
              <ShieldCheck />
              {t("nav.admin")}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); toggle(); }}>
          {theme === "dark" ? <Sun /> : <Moon />}
          {t("theme.switchTo", { theme: theme === "dark" ? t("theme.light") : t("theme.dark") })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Stays open while it signs out: the item shows it is busy. */}
        <DropdownMenuItem aria-busy={leaving || undefined} onSelect={(event) => { event.preventDefault(); void logout(); }}>
          {leaving ? <OrbitSpinner /> : <LogOut />}
          {t("topbar.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
        <span className="hidden items-center gap-1.5 pr-1 lg:flex">
          {total != null ? (
            <span className="num font-display text-[15px]" data-testid="account-total">{format.usd(total + (trading.mode === "paper" ? 0 : inCopies), { digits: 2 })}</span>
          ) : !trading.available || (trading.mode === "paper" ? paper.isError : wallet.isError) ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <Skeleton className="h-4 w-16" />
          )}
          <ChevronDown className="size-4 text-muted-foreground" strokeWidth={2.4} aria-hidden />
        </span>
      </AccountMenu>
      {trading.mode !== "paper" && trading.available ? <Button onClick={openDeposit}>
        {t("portfolio.deposit")}
      </Button> : null}
    </div>
  );
}
