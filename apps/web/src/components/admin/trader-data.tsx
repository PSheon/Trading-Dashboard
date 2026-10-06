"use client";

import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { buttonVariants } from "@/components/ui/button-variants";
import { Drawer } from "@/components/ui/drawer";
import { useI18n } from "@/i18n/provider";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/auth";
import type { LeaderList } from "@/lib/contracts";
import { truncateAddress } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import { AdminSubTabs } from "./admin-shell";
import { AdminJobs } from "./jobs";
import { AdminKols } from "./kols";
import { AdminLists } from "./lists";
import { useJobCounts } from "./overview";
import { TraderDiagnosis } from "./trader-detail";
import { AdminCard, Fact, Facts } from "./ui";

export const TRADER_SUB_TABS = {
  "/admin/traders": "admin.sub.kols",
  "/admin/traders/lists": "admin.sub.lists",
  "/admin/traders/jobs": "admin.sub.jobs",
} as const;

/**
 * 交易者資料 (C-AdminNew-Data): an address search that opens the diagnosis
 * (the old 交易員診斷 page) in a drawer (?address=), the sub-tabs KOL / 名單 /
 * 回補工作, and the two summary cards.
 */
export function AdminTraderData({ view }: { view: "kols" | "lists" | "jobs" }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const canDiagnose = usePermission("traders.read");
  const address = (params.get("address") ?? "").trim().toLowerCase();
  const [draft, setDraft] = useState(address);
  const valid = /^0x[0-9a-f]{40}$/.test(draft.trim().toLowerCase());
  const open = (value: string | null) => router.replace(value ? `${pathname}?address=${encodeURIComponent(value)}` : pathname, { scroll: false });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {canDiagnose ? (
          <form className="min-w-0 flex-1" role="search" onSubmit={(e) => { e.preventDefault(); if (valid) open(draft.trim().toLowerCase()); }}>
            <label className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-5 size-[18px] -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={42}
                spellCheck={false}
                autoComplete="off"
                aria-label={t("admin.traders.searchLabel")}
                placeholder={t("admin.traders.searchPlaceholder")}
                className="h-[52px] w-full rounded-full border-2 border-transparent bg-raised pr-5 pl-12 text-[15px] font-extrabold outline-none placeholder:font-bold placeholder:text-subtle-foreground focus-visible:border-primary"
              />
            </label>
          </form>
        ) : null}
        <AdminSubTabs tab="traders" labels={TRADER_SUB_TABS} />
      </div>
      {view === "kols" ? <AdminKols /> : view === "lists" ? <AdminLists /> : <AdminJobs />}
      {/* Each sub-page shows the other two's summaries (the board's two cards). */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {view !== "jobs" ? <JobsSummary /> : null}
        {view !== "lists" ? <ListsSummary /> : null}
      </div>
      <Drawer open={/^0x[0-9a-f]{40}$/.test(address)} onOpenChange={(next) => { if (!next) { open(null); setDraft(""); } }}
        title={t("admin.traders.diagnosisTitle", { address: truncateAddress(address) })} description={t("adminTrader.hint")}>
        {address ? <TraderDiagnosis address={address} /> : null}
      </Drawer>
    </div>
  );
}

function JobsSummary() {
  const { t } = useI18n();
  const canJobs = usePermission("jobs.read");
  const counts = useJobCounts(canJobs);
  if (!canJobs) return null;
  return (
    <AdminCard title={t("admin.traders.jobsSummary")} action={<Link href="/admin/traders/jobs" className={buttonVariants({ variant: "secondary", size: "sm" })}>{t("admin.traders.viewAll")}</Link>}>
      <Facts>
        <Fact label={t("jobs.running")} value={counts.running} />
        <Fact label={t("jobs.pending")} value={counts.pending} />
        <Fact label={t("jobs.failed")} tone={counts.failed ? "negative" : undefined} value={counts.ready ? counts.failed : "—"} />
      </Facts>
    </AdminCard>
  );
}

function ListsSummary() {
  const { t, format } = useI18n();
  const canLists = usePermission("lists.read");
  const lists = useQuery({ queryKey: queryKeys.admin.lists, queryFn: ({ signal }) => api.get<LeaderList[]>("/lists", signal), enabled: canLists, refetchInterval: false });
  if (!canLists) return null;
  const latest = lists.data?.[0];
  return (
    <AdminCard title={t("admin.traders.listsSummary")} action={<Link href="/admin/traders/lists" className={buttonVariants({ variant: "secondary", size: "sm" })}>{t("admin.traders.viewAll")}</Link>}>
      <Facts>
        <Fact label={t("admin.traders.currentVersion")} value={latest ? `v${latest.id} · ${format.date(latest.importedAt)}` : lists.data ? t("admin.traders.noList") : "—"} />
        <Fact label={t("admin.traders.file")} value={latest?.fileName ?? "—"} />
        <Fact label={t("admin.traders.source")} value={latest?.source ?? "—"} />
      </Facts>
    </AdminCard>
  );
}
