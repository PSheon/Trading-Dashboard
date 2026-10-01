"use client";

import { Banknote, Briefcase, Globe, LogOut, Settings, ShieldCheck } from "lucide-react";
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
import { useWallet } from "@/lib/wallet";

/** Top-right, as on CopyDog: signed out → language + 登入; signed in → the
 * balance pill (total value + 儲值) and the avatar menu. Plus the demo badge
 * in fixture mode. */
export function AccountControls() {
  const { t } = useI18n();
  const { status } = useAuth();
  return (
    <div className="flex shrink-0 items-center gap-2">
      {API_FIXTURES ? (
        <span className="hidden rounded-full border border-dashed border-border-strong px-2.5 py-1 text-[0.6875rem] font-medium text-muted-foreground lg:inline">
          {t("topbar.fixtureBadge")}
        </span>
      ) : null}
      {status === "signedIn" ? <BalancePill /> : <LocaleMenu />}
      <AuthButton />
    </div>
  );
}

function LocaleMenu() {
  const { t } = useI18n();
  return (
    <LanguageMenu
      trigger={
        <Button variant="secondary" size="icon" className="size-10 md:size-11" aria-label={t("topbar.language")}>
          <Globe className="size-5" />
        </Button>
      }
    />
  );
}

export function AuthButton() {
  const { t } = useI18n();
  const { status, mode, login, logout, identity } = useAuth();
  const { data: me } = useMe();
  const isAdmin = useIsAdmin();

  if (status === "disabled") {
    return (
      <Tooltip content={t("topbar.loginUnavailable")}>
        <span tabIndex={0} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Button disabled size="lg" className="h-10 px-5 md:h-11">
            {t("topbar.login")}
          </Button>
        </span>
      </Tooltip>
    );
  }

  if (status === "loading") {
    return <Skeleton className="h-10 w-28 rounded-full md:h-11 md:w-36" />;
  }

  if (status !== "signedIn") {
    return (
      <Button
        size="lg"
        className="h-10 px-5 md:h-11"
        onClick={login}
      >
        {mode === "fixture" ? t("topbar.fixtureLogin") : t("topbar.login")}
      </Button>
    );
  }

  const label = me?.displayName || me?.email?.split("@")[0] || identity || t("topbar.account");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("topbar.account")}
          className="flex size-10 items-center justify-center rounded-full bg-raised text-sm font-semibold outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring md:size-11"
        >
          {label.slice(0, 1).toUpperCase()}
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
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut />
          {t("topbar.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** CopyDog's signed-in pill: cash icon, total value, 儲值 (opens the
 * deposit modal). The value is the main account's /me/wallet total. */
function BalancePill() {
  const { t, format } = useI18n();
  const wallet = useWallet();
  const { openDeposit } = useWalletModals();
  return (
    <div className="hidden h-11 items-center gap-2 rounded-full bg-raised py-1 pr-1 pl-3.5 sm:flex">
      <Banknote className="size-5 text-positive" aria-hidden />
      {wallet.data ? (
        <span className="num text-sm font-semibold">{format.usd(wallet.data.totalValue, { digits: 2 })}</span>
      ) : wallet.isError ? (
        <span className="text-sm text-muted-foreground">—</span>
      ) : (
        <Skeleton className="h-4 w-12" />
      )}
      <Button className="h-9 px-3.5" onClick={openDeposit}>
        {t("portfolio.deposit")}
      </Button>
    </div>
  );
}
