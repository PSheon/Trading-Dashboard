"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity, Layers, ShieldCheck, Users, Wallet } from "lucide-react";
import { cn } from "cn";
import { copyOrderStatusEnum, copyStrategyStatusEnum, type CopyControlCommand } from "@trading-dashboard/shared/contracts";

import { KpiCard } from "@/components/admin/overview";
import { ErrorState, Panel, SectionHeader, Skeleton } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { signalLagSeconds, useAdminCopyExposure, useAdminCopyOrders, useAdminCopyOverview } from "@/lib/admin-copy";
import { useNow } from "@/lib/use-now";
import { ControlDialog, type ControlRequest } from "./control-dialog";
import { Chip, ControlButtons, ControlState, CopyAdminNav, OrdersTable } from "./shared";

/** A signal waiting this long means opens are about to go stale (the default maxSignalAgeSeconds is 120). */
const LAG_WARN_SECONDS = 60;
const FAILURES = ["rejected", "cancelled"] as const;

export function AdminCopyOverview() {
  const { t, format } = useI18n();
  const now = useNow();
  const overview = useAdminCopyOverview();
  const exposure = useAdminCopyExposure();
  const failures = useAdminCopyOrders({ status: FAILURES, limit: 20 });
  const recent = useAdminCopyOrders({ limit: 20 });
  const [command, setCommand] = useState<CopyControlCommand | null>(null);

  const d = overview.data;
  const users = exposure.data?.items ?? [];
  const totalExposure = exposure.data ? (users.some((u) => u.exposureUsd === null) ? null : users.reduce((a, u) => a + (u.exposureUsd ?? 0), 0)) : null;
  const liveStrategies = users.reduce((a, u) => a + u.strategies, 0);
  const request: ControlRequest | null = command && d
    ? { target: { scope: "platform" }, targetLabel: t("copyAdmin.dialog.allUsers"), command, revision: d.platform.revision,
        impact: { strategies: liveStrategies, users: users.length, exposureUsd: totalExposure } }
    : null;

  let body: React.ReactNode;
  if (overview.isError && !d) {
    body = <Panel><ErrorState message={overview.error.message} onRetry={() => overview.refetch()} /></Panel>;
  } else if (!d) {
    body = <Skeleton className="h-96 rounded-2xl" />;
  } else {
    const lag = signalLagSeconds(d.outbox.oldestPendingAt, now);
    const behind = d.outbox.failed > 0 || (lag !== null && lag > LAG_WARN_SECONDS);
    body = (
      <>
        <Panel className="flex flex-col gap-4 p-5" aria-labelledby="copy-platform-title">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 id="copy-platform-title" className="text-lg font-bold">{t("copyAdmin.platform.title")}</h2>
            <Chip tone="info">{t(`copyAdmin.mode.${d.mode}`)}</Chip>
            <ControlState state={d.platform} />
            <span className="num ml-auto text-xs text-subtle-foreground">
              {t("copyAdmin.platform.revision", { revision: d.platform.revision })}
              {d.platform.updatedAt ? ` · ${format.dateTime(d.platform.updatedAt)}` : ""}
            </span>
          </div>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{t("copyAdmin.platform.hint")}</p>
          <ControlButtons state={d.platform} onPick={setCommand} />
        </Panel>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard icon={Layers} label={t("copyAdmin.kpi.strategies")} value={format.num((d.strategies.active ?? 0) + (d.strategies.paused ?? 0) + (d.strategies.stopping ?? 0), 0)}
            sub={copyStrategyStatusEnum.map((s) => `${t(`copyAdmin.strategyStatus.${s}`)} ${d.strategies[s] ?? 0}`).join(" · ")} />
          <KpiCard icon={Users} label={t("copyAdmin.kpi.users")} value={exposure.data ? format.num(users.length, 0) : "—"}
            sub={t("copyAdmin.kpi.usersSub", { count: users.filter((u) => u.control.pauseNewRisk || u.control.reduceOnly).length })} />
          <KpiCard icon={Wallet} label={t("copyAdmin.kpi.exposure")} value={totalExposure === null ? "—" : format.usd(totalExposure, { compact: true })}
            sub={t("copyAdmin.kpi.exposureSub", { allocated: format.usd(users.reduce((a, u) => a + u.allocated, 0), { compact: true }) })} />
          <KpiCard icon={ShieldCheck} label={t("copyAdmin.kpi.policy")} value={`v${d.riskPolicyVersion}`}
            sub={<Link href="/admin/copy/risk" className="underline decoration-border underline-offset-4">{t("copyAdmin.kpi.policySub")}</Link>} />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Panel className="p-5" aria-labelledby="copy-backlog-title">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="size-4 text-primary" />
              <h2 id="copy-backlog-title" className="text-[0.9375rem] font-bold">{t("copyAdmin.backlog.title")}</h2>
              <Chip tone={behind ? "bad" : "good"}>{t(behind ? "copyAdmin.backlog.behind" : "copyAdmin.backlog.ok")}</Chip>
            </div>
            <dl className="divide-y divide-border text-sm">
              <Row label={t("copyAdmin.backlog.pending")} value={format.num(d.outbox.pending, 0)} />
              <Row label={t("copyAdmin.backlog.lag")} value={lag === null ? t("copyAdmin.backlog.none") : lag < 120 ? t("copyAdmin.backlog.seconds", { seconds: lag }) : format.duration(lag)} bad={lag !== null && lag > LAG_WARN_SECONDS} />
              <Row label={t("copyAdmin.backlog.failed")} value={format.num(d.outbox.failed, 0)} bad={d.outbox.failed > 0} />
              <Row label={t("copyAdmin.backlog.checkpoint")} value={`#${d.outbox.checkpoint}`} />
            </dl>
          </Panel>
          <Panel className="p-5" aria-labelledby="copy-orders24-title">
            <h2 id="copy-orders24-title" className="mb-3 text-[0.9375rem] font-bold">{t("copyAdmin.orders24h.title")}</h2>
            <dl className="grid grid-cols-2 gap-x-6 text-sm sm:grid-cols-3">
              {copyOrderStatusEnum.filter((s) => (d.orders24h[s] ?? 0) > 0 || s === "filled" || s === "rejected" || s === "cancelled").map((s) => (
                <div key={s} className="flex items-center justify-between gap-2 border-b border-border py-2">
                  <dt className="text-muted-foreground">{t(`copyAdmin.orderStatus.${s}`)}</dt>
                  <dd className={cn("num font-semibold", s === "rejected" && (d.orders24h[s] ?? 0) > 0 && "text-negative")}>{format.num(d.orders24h[s] ?? 0, 0)}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>

        <section aria-labelledby="copy-failures-title">
          <SectionHeader title={<span id="copy-failures-title">{t("copyAdmin.failures.title")}</span>}
            action={<Link href="/admin/copy/orders?status=failed" className="text-sm font-semibold text-primary">{t("common.viewAll")}</Link>} />
          <Panel className="overflow-hidden">
            {failures.isError && !failures.data ? <ErrorState message={failures.error.message} onRetry={() => failures.refetch()} />
              : !failures.data ? <Skeleton className="m-5 h-32" />
              : failures.data.items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.failures.empty")}</p>
              : <OrdersTable items={failures.data.items} />}
          </Panel>
        </section>

        <section aria-labelledby="copy-recent-title">
          <SectionHeader title={<span id="copy-recent-title">{t("copyAdmin.recent.title")}</span>}
            action={<Link href="/admin/copy/orders" className="text-sm font-semibold text-primary">{t("common.viewAll")}</Link>} />
          <Panel className="overflow-hidden">
            {recent.isError && !recent.data ? <ErrorState message={recent.error.message} onRetry={() => recent.refetch()} />
              : !recent.data ? <Skeleton className="m-5 h-32" />
              : recent.data.items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.recent.empty")}</p>
              : <OrdersTable items={recent.data.items} />}
          </Panel>
        </section>

        <section aria-labelledby="copy-events-title">
          <SectionHeader title={<span id="copy-events-title">{t("copyAdmin.events.title")}</span>} />
          <Panel className="overflow-hidden">
            {d.events.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.events.empty")}</p> : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("copyAdmin.cols.time")}</TableHead>
                    <TableHead>{t("copyAdmin.cols.command")}</TableHead>
                    <TableHead>{t("copyAdmin.cols.scope")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("copyAdmin.cols.actor")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("copyAdmin.cols.reason")}</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">{t("copyAdmin.cols.effect")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(e.createdAt)}</TableCell>
                      <TableCell className="font-semibold sm:whitespace-nowrap">
                        {t(`copyAdmin.commands.${e.command}`)}
                        {e.reason ? <span className="mt-1 block text-xs font-normal whitespace-normal text-muted-foreground sm:hidden">{e.reason}</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{t(`copyAdmin.scope.${e.scope}`)}{e.scope === "platform" ? "" : ` #${e.scopeId}`} · r{e.revision}</TableCell>
                      <TableCell className="hidden max-w-[12rem] truncate md:table-cell">{e.actorEmail ?? (e.actorUserId === null ? "—" : `#${e.actorUserId}`)}</TableCell>
                      <TableCell className="hidden min-w-[10rem] text-muted-foreground sm:table-cell">{e.reason ?? "—"}</TableCell>
                      <TableCell className="hidden whitespace-nowrap text-right sm:table-cell">{t("copyAdmin.events.effect", { cancelled: e.result.cancelledOrders, closed: e.result.closeOrders })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </section>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <CopyAdminNav />
      {overview.isError && d ? <p role="alert" className="rounded-xl bg-warning/10 p-3 text-sm text-warning">{t("copyAdmin.stale")}</p> : null}
      {body}
      <ControlDialog request={request} onClose={() => setCommand(null)} />
    </div>
  );
}

function Row({ label, value, bad = false }: { label: string; value: React.ReactNode; bad?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("num font-semibold", bad && "text-negative")}>{value}</dd>
    </div>
  );
}
