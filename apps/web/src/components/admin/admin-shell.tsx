"use client";

import { LogIn, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { EmptyState, ErrorState, PageHeader, Panel, SignInPrompt, SkelBar } from "@/components/page";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { TabLinks } from "./ui";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import type { Permission } from "@trading-dashboard/shared/contracts";
import { hasPermission } from "@/lib/permissions";
import { useAuth, useMe } from "@/lib/auth";

/** The five tabs (v29 boards; Paul 2026-10-05). A tab links to its first
 * sub-page the account may open. */
export const ADMIN_TABS: { key: string; label: MessageKey; pages: { href: string; permission: Permission }[] }[] = [
  { key: "overview", label: "admin.nav.overview", pages: [{ href: "/admin", permission: "overview.read" }] },
  { key: "copy", label: "copyAdmin.nav.title", pages: [
    { href: "/admin/copy", permission: "copy.read" }, { href: "/admin/copy/orders", permission: "copy.read" },
    { href: "/admin/copy/risk", permission: "copy.read" }, { href: "/admin/copy/testnet", permission: "copy.read" },
  ] },
  { key: "users", label: "admin.nav.users", pages: [{ href: "/admin/users", permission: "users.read" }, { href: "/admin/users/audit", permission: "audit.read" }] },
  { key: "traders", label: "admin.nav.traderData", pages: [
    { href: "/admin/traders", permission: "kols.manage" }, { href: "/admin/traders/lists", permission: "lists.read" },
    { href: "/admin/traders/jobs", permission: "jobs.read" },
  ] },
  { key: "settings", label: "admin.nav.settings", pages: [{ href: "/admin/settings", permission: "settings.read" }] },
];
const PAGES = ADMIN_TABS.flatMap((tab) => tab.pages.map((page) => ({ ...page, tab: tab.key })));

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

  const current = PAGES.find((page) => page.href === pathname);
  const allowed = status === "signedIn" && !me.isError && hasPermission(me.data, "admin.access");
  const pageAllowed = allowed && Boolean(current && hasPermission(me.data, current.permission));
  const tabs = ADMIN_TABS.map((tab) => ({ tab, href: tab.pages.find((page) => hasPermission(me.data, page.permission))?.href })).filter((x): x is { tab: (typeof ADMIN_TABS)[number]; href: string } => Boolean(x.href));
  let body: React.ReactNode;
  const pending = status === "loading" || (status === "signedIn" && me.isPending);
  if (pending) {
    body = <AdminBodySkeleton />;
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
      <PageHeader title={t("admin.title")} />
      {pending ? (
        // The tab row while the account's permissions load.
        <div aria-hidden="true" className="ui-skeleton flex h-[52px] w-fit max-w-full gap-0.5 overflow-hidden rounded-[26px] bg-raised p-1 [--skel-bar:var(--border)]">
          <span className="h-11 w-[68px] shrink-0 rounded-[22px] bg-primary/60" />
          {["w-12", "w-16", "w-24", "w-12"].map((w, i) => <SkelBar key={i} line="h-11 px-4" className={cn("h-3", w)} />)}
        </div>
      ) : allowed ? (
        <TabLinks
          label={t("admin.title")}
          items={tabs.map(({ tab, href }) => ({ href, label: t(tab.label), active: current?.tab === tab.key || (!current && tab.pages.some((page) => pathname.startsWith(`${page.href}/`))) }))}
        />
      ) : null}
      {body}
    </div>
  );
}

/** A tab's sub-pages the account may open, as the dark-ink sub-tabs. */
export function AdminSubTabs({ tab, labels }: { tab: string; labels: Record<string, MessageKey> }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const me = useMe();
  const pages = ADMIN_TABS.find((x) => x.key === tab)?.pages.filter((page) => hasPermission(me.data, page.permission)) ?? [];
  if (pages.length < 2) return null;
  return <TabLinks tone="sub" label={t(ADMIN_TABS.find((x) => x.key === tab)!.label)} items={pages.map((page) => ({ href: page.href, label: t(labels[page.href]), active: page.href === pathname }))} />;
}

/** An admin page's content while it loads: most are a card holding a
 * table, so a card with a heading line over a table's header and rows. */
export function AdminBodySkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <SkelBar line="h-5" className="ui-skeleton h-3 w-72 max-w-full bg-raised" />
      <TableSkeleton columns={[{}, {}, { right: true }, { right: true }, { right: true }]} rows={6} />
    </div>
  );
}
