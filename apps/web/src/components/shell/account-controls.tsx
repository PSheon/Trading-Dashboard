"use client";

import { Globe, LogOut, Settings, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { Skeleton } from "@/components/page";
import { AddressAvatar } from "@/components/traders/address-avatar";
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
import { LOCALES, isLocale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useChangeLocale } from "@/lib/use-change-locale";
import { useAuth, useIsAdmin, useMe } from "@/lib/auth";
import { API_FIXTURES } from "@/lib/config";

/** Top-right: demo badge (fixture mode), language, login / account menu. */
export function AccountControls() {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center gap-2">
      {API_FIXTURES ? (
        <span className="hidden rounded-full border border-dashed border-border-strong px-2.5 py-1 text-[0.6875rem] font-medium text-muted-foreground lg:inline">
          {t("topbar.fixtureBadge")}
        </span>
      ) : null}
      <LocaleMenu />
      <AuthButton />
    </div>
  );
}

function LocaleMenu() {
  const { t, locale } = useI18n();
  const changeLocale = useChangeLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="icon" className="size-10 md:size-11" aria-label={t("topbar.language")}>
          <Globe className="size-[18px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{t("topbar.language")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (isLocale(value)) changeLocale(value);
          }}
        >
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

function AuthButton() {
  const { t } = useI18n();
  const { status, mode, login, logout, identity } = useAuth();
  const { data: me } = useMe();
  const isAdmin = useIsAdmin();

  if (status === "disabled") {
    return (
      <Tooltip content={t("topbar.loginUnavailable")}>
        <span tabIndex={0} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Button disabled size="lg" className="h-10 px-5 md:h-11 md:px-6">
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
        className="h-10 px-5 md:h-11 md:px-6"
        onClick={login}
      >
        {mode === "fixture" ? t("topbar.fixtureLogin") : t("topbar.login")}
      </Button>
    );
  }

  const label = me?.displayName || me?.email || identity || t("topbar.account");
  const seed = me?.walletAddress || me?.privyUserId || label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("topbar.account")}
          className="flex items-center gap-2 rounded-full bg-raised p-1 pr-1 outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring md:pr-3.5"
        >
          <AddressAvatar seed={seed} size={34} />
          <span className="hidden max-w-32 truncate text-sm font-semibold md:inline">{label}</span>
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
