"use client";

import { LogIn, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { EmptyState, PageHeader, Panel, SignInPrompt, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import type { Permission } from "@trading-dashboard/shared/contracts";
import { hasPermission } from "@/lib/permissions";
import { useAuth, useMe } from "@/lib/auth";

const SECTIONS: { href: string; label: MessageKey; permission: Permission }[] = [
  { href: "/admin", label: "admin.nav.overview", permission: "overview.read" },
  { href: "/admin/revenue", label: "admin.nav.revenue", permission: "revenue.read" },
  { href: "/admin/traders", label: "adminTrader.title", permission: "traders.read" },
  { href: "/admin/users", label: "admin.nav.users", permission: "users.read" },
  { href: "/admin/settings", label: "admin.nav.settings", permission: "settings.read" },
  { href: "/admin/lists", label: "admin.nav.lists", permission: "lists.read" },
  { href: "/admin/kols", label: "admin.nav.kols", permission: "kols.manage" },
  { href: "/admin/rules", label: "admin.nav.rules", permission: "rules.read" },
  { href: "/admin/audit", label: "settingsOps.audit", permission: "audit.read" },
  { href: "/admin/jobs", label: "jobs.title", permission: "jobs.read" },
  { href: "/admin/system", label: "admin.nav.system", permission: "admin.access" },
];

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
          className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 no-scrollbar md:mx-0 md:px-0"
        >
          {SECTIONS.filter((s) => hasPermission(me.data, s.permission)).map((s) => {
            const active = s.href === "/admin" ? pathname === "/admin" : pathname.startsWith(s.href);
            return (
              <Link
                key={s.href}
                href={s.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative shrink-0 px-3 py-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
                )}
              >
                {t(s.label)}
                {active ? <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary" /> : null}
              </Link>
            );
          })}
        </nav>
      ) : null}
      {body}
    </div>
  );
}
