"use client";

import { LogIn, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { EmptyState, ErrorState, PageHeader, Panel, SignInPrompt, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import type { Permission } from "@trading-dashboard/shared/contracts";
import { hasPermission } from "@/lib/permissions";
import { useAuth, useMe } from "@/lib/auth";

const SECTIONS: { href: string; label: MessageKey; permission: Permission }[] = [
  { href: "/admin", label: "admin.nav.overview", permission: "overview.read" },
  { href: "/admin/revenue", label: "admin.nav.revenue", permission: "revenue.read" },
  { href: "/admin/data-sources", label: "sources.title", permission: "sources.read" },
  { href: "/admin/traders", label: "adminTrader.title", permission: "traders.read" },
  { href: "/admin/copy", label: "copyAdmin.nav.title", permission: "copy.read" },
  { href: "/admin/users", label: "admin.nav.users", permission: "users.read" },
  { href: "/admin/settings", label: "admin.nav.settings", permission: "settings.read" },
  { href: "/admin/lists", label: "admin.nav.lists", permission: "lists.read" },
  { href: "/admin/kols", label: "admin.nav.kols", permission: "kols.manage" },
  { href: "/admin/rules", label: "admin.nav.rules", permission: "rules.read" },
  { href: "/admin/activity", label: "admin.nav.activity", permission: "admin.access" },
  { href: "/admin/audit", label: "settingsOps.audit", permission: "audit.read" },
  { href: "/admin/jobs", label: "jobs.title", permission: "jobs.read" },
  { href: "/admin/system", label: "admin.nav.system", permission: "admin.access" },
];

/** 401 / 403 / 404: the answer about this account; anything else may pass. */
function isPermanent(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Admin area frame: title, sub-navigation, and the role gate (the api
 * enforces it too — this only avoids showing admins-only UI). */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { status } = useAuth();
  const me = useMe();

  const current = SECTIONS.find((section) => section.href === pathname) ?? [...SECTIONS].reverse().find((section) => pathname.startsWith(`${section.href}/`));
  const allowed = status === "signedIn" && !me.isError && hasPermission(me.data, "admin.access");
  const pageAllowed = allowed && Boolean(current && hasPermission(me.data, current.permission));
  let body: React.ReactNode;
  if (status === "loading" || (status === "signedIn" && me.isPending)) {
    body = <Skeleton className="h-64 rounded-2xl" />;
  } else if (status === "signedIn" && me.isError && !me.data && !isPermanent(me.error)) {
    // A temporary failure (network, 5xx, busy) is not "no permission".
    body = (
      <Panel>
        <ErrorState onRetry={() => void me.refetch()} />
      </Panel>
    );
  } else if (status !== "signedIn") {
    body = (
      <Panel>
        <SignInPrompt icon={LogIn} title={t("admin.signInTitle")} body={t("admin.forbidden")} />
      </Panel>
    );
  } else if (!pageAllowed) {
    body = (
      <Panel>
        <EmptyState
          icon={ShieldAlert}
          title={t("admin.forbiddenTitle")}
          body={t("admin.forbidden")}
          action={
            <Button asChild variant="secondary">
              <Link href="/">{t("notFound.home")}</Link>
            </Button>
          }
        />
      </Panel>
    );
  } else {
    body = children;
  }


  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("admin.title")} subtitle={t("admin.subtitle")} />
      {allowed ? (
        <nav
          aria-label={t("admin.title")}
          className="flex gap-0.5 overflow-x-auto rounded-[28px] bg-raised p-1 no-scrollbar"
        >
          {SECTIONS.filter((s) => hasPermission(me.data, s.permission)).map((s) => {
            const active = s.href === "/admin" ? pathname === "/admin" : pathname.startsWith(s.href);
            return (
              <Link
                key={s.href}
                href={s.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-11 shrink-0 items-center rounded-[22px] px-4 text-sm whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "bg-primary font-extrabold text-primary-foreground" : "font-bold text-muted-foreground hover:bg-raised-hover hover:text-foreground",
                )}
              >
                {t(s.label)}
              </Link>
            );
          })}
        </nav>
      ) : null}
      {body}
    </div>
  );
}
