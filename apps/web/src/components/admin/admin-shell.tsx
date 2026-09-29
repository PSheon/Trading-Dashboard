"use client";

import { LogIn, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { EmptyState, PageHeader, Panel, SignInPrompt, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { useAuth, useMe } from "@/lib/auth";

const SECTIONS: { href: string; label: MessageKey }[] = [
  { href: "/admin", label: "admin.nav.overview" },
  { href: "/admin/revenue", label: "admin.nav.revenue" },
  { href: "/admin/users", label: "admin.nav.users" },
  { href: "/admin/settings", label: "admin.nav.settings" },
  { href: "/admin/lists", label: "admin.nav.lists" },
  { href: "/admin/rules", label: "admin.nav.rules" },
  { href: "/admin/system", label: "admin.nav.system" },
];

/** Admin area frame: title, sub-navigation, and the role gate (the api
 * enforces it too — this only avoids showing admins-only UI). */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { status } = useAuth();
  const me = useMe();

  let body: React.ReactNode;
  if (status === "loading" || (status === "signedIn" && me.isPending)) {
    body = <Skeleton className="h-64 rounded-2xl" />;
  } else if (status !== "signedIn") {
    body = (
      <Panel>
        <SignInPrompt icon={LogIn} title={t("admin.signInTitle")} body={t("admin.forbidden")} />
      </Panel>
    );
  } else if (me.data?.role !== "admin") {
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

  const allowed = status === "signedIn" && me.data?.role === "admin";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("admin.title")} subtitle={t("admin.subtitle")} />
      {allowed ? (
        <nav
          aria-label={t("admin.title")}
          className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 no-scrollbar md:mx-0 md:px-0"
        >
          {SECTIONS.map((s) => {
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
