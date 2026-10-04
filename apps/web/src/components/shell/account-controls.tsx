"use client";

import { Briefcase, ChevronDown, Globe, LogOut, Moon, Settings, ShieldCheck, Sun } from "lucide-react";
import { cn } from "cn";
import Link from "next/link";

import { Skeleton } from "@/components/page";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { useWallet } from "@/lib/wallet";

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
        <Button variant="secondary" size="icon" className="size-11 md:size-[52px]" aria-label={t("topbar.language")}>
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
          <Button disabled size="lg" className={cn("px-6", compact ? "h-11" : "h-11 md:h-[52px]")}>
            {t("topbar.login")}
          </Button>
        </span>
      </Tooltip>
    );
  }

  if (status === "loading") {
    return <Skeleton className={cn("rounded-full", compact ? "h-11 w-20" : "h-11 w-24 md:h-[52px] md:w-28")} />;
  }

  if (status !== "signedIn") {
    return (
      <Button
        size="lg"
        className={cn("px-6 text-base", compact ? "h-11" : "h-11 md:h-[52px]")}
        onClick={login}
      >
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
  const { logout, identity } = useAuth();
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
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut />
          {t("topbar.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Orbit's signed-in pill: the avatar and total value open the account
 * menu; 儲值 opens the deposit modal. The value is the main account's
 * /me/wallet total (shown from 1024px). */
function AccountPill() {
  const { t, format } = useI18n();
  const wallet = useWallet();
  const { openDeposit } = useWalletModals();
  return (
    <div className="flex h-[52px] items-center gap-1 rounded-[26px] bg-raised p-1">
      <AccountMenu>
        <span className="hidden items-center gap-1.5 pr-1 lg:flex">
          {wallet.data ? (
            <span className="num font-display text-[15px]">{format.usd(wallet.data.totalValue, { digits: 2 })}</span>
          ) : wallet.isError ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <Skeleton className="h-4 w-16" />
          )}
          <ChevronDown className="size-4 text-muted-foreground" strokeWidth={2.4} aria-hidden />
        </span>
      </AccountMenu>
      <Button className="h-11 px-4 text-[15px]" onClick={openDeposit}>
        {t("portfolio.deposit")}
      </Button>
    </div>
  );
}
