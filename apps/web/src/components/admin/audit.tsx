"use client";
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { auditEvents, type AuditResponse } from "@/lib/contracts";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useI18n } from "@/i18n/provider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { AdminSubTabs } from "./admin-shell";
import { AdminCard, Notice } from "./ui";
import { USERS_SUB_TABS } from "./users";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminAudit() {
  const { t } = useI18n();
  const [filters, setFilters] = useState({ event: "", actorKind: "", actorUserId: "", target: "" });
  const [applied, setApplied] = useState(filters);
  const [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({ limit: "25" });
  for (const [key, value] of Object.entries(applied)) if (value) params.set(key, value);
  if (cursors.length) params.set("beforeId", cursors.at(-1)!);
  const qs = params.toString();
  const query = useQuery({ queryKey: queryKeys.admin.audit(qs), queryFn: ({ signal }) => api.get<AuditResponse>(`/admin/audit?${qs}`, signal) });
  return <section className="flex flex-col gap-5" aria-labelledby="audit-title">
    <AdminSubTabs tab="users" labels={USERS_SUB_TABS} />
    <h2 id="audit-title" className="sr-only">{t("settingsOps.audit")}</h2>
    <p className="type-caption max-w-3xl">{t("settingsOps.auditHint")}</p>
    <AdminCard><form className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" onSubmit={e => { e.preventDefault(); setApplied({ ...filters, target: filters.target.trim() }); setCursors([]); }}>
      <div className="grid gap-2"><Label htmlFor="audit-event">{t("settingsOps.event")}</Label>
        <Select id="audit-event" className="w-full" value={filters.event} onValueChange={event => setFilters({ ...filters, event })} options={[{ value: "", label: t("settingsOps.all") }, ...auditEvents.map(event => ({ value: event, label: event }))]} /></div>
      <div className="grid gap-2"><Label htmlFor="audit-actor">{t("settingsOps.actorKind")}</Label>
        <Select id="audit-actor" className="w-full" value={filters.actorKind} onValueChange={actorKind => setFilters({ ...filters, actorKind })} options={[{ value: "", label: t("settingsOps.all") }, ...(["user", "service", "system"] as const).map(kind => ({ value: kind, label: t(`settingsOps.${kind}`) }))]} /></div>
      <div className="grid gap-2"><Label htmlFor="audit-user">{t("settingsOps.actorUserId")}</Label><Input id="audit-user" type="number" min={1} max={2147483647} step={1} value={filters.actorUserId} onChange={e => setFilters({ ...filters, actorUserId: e.target.value })} /></div>
      <div className="grid gap-2"><Label htmlFor="audit-target">{t("settingsOps.target")}</Label><Input id="audit-target" maxLength={256} value={filters.target} onChange={e => setFilters({ ...filters, target: e.target.value })} /></div>
      <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-4"><Button type="submit">{t("settingsOps.search")}</Button><Button type="button" variant="secondary" loading={query.isFetching} disabled={!(query.isFetching) && (query.isFetching)} onClick={() => void query.refetch()}>{t("settingsOps.refresh")}</Button></div>
    </form></AdminCard>
    {query.isError ? <Notice>{t("settingsOps.failed")}</Notice> : query.data ? <AuditEntries items={query.data.items} /> : <TableSkeleton rows={6} columns={[{ label: t("admin.audit.cols.time") }, { label: t("settingsOps.event") }, { label: t("settingsOps.actorKind") }, { label: t("settingsOps.target") }, {}]} />}
    <div className="flex flex-wrap items-center justify-between gap-3"><Button variant="secondary" disabled={!cursors.length || query.isFetching} onClick={() => setCursors(cursors.slice(0, -1))}>{t("settingsOps.previous")}</Button><p className="num type-caption">{t("settingsOps.page", { page: cursors.length + 1 })}</p><Button variant="secondary" disabled={!query.data?.nextCursor || query.isFetching || query.isError} onClick={() => setCursors([...cursors, query.data!.nextCursor!])}>{t("settingsOps.next")}</Button></div>
  </section>;
}
/** The audit ledger as data rows; 詳情 opens a row's before / after. */
export function AuditEntries({ items }: { items: AuditResponse["items"] }) {
  const { t, format } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <p className="rounded-[18px] bg-raised px-[18px] py-5 text-sm font-bold text-muted-foreground">{t("settingsOps.empty")}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("admin.audit.cols.time")}</TableHead>
          <TableHead>{t("settingsOps.event")}</TableHead>
          <TableHead className="hidden sm:table-cell">{t("settingsOps.actorKind")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("settingsOps.target")}</TableHead>
          <TableHead><span className="sr-only">{t("settingsOps.details")}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((row) => (
          <Fragment key={row.id}>
            <TableRow data-state={open === row.id ? "selected" : undefined}>
              <TableCell className="text-muted-foreground"><time dateTime={row.createdAt}>{format.dateTime(row.createdAt)}</time></TableCell>
              <TableCell>{row.event} <span className="text-muted-foreground">#{row.id}</span></TableCell>
              <TableCell className="hidden sm:table-cell">{t(`settingsOps.${row.actorKind}`)}{row.actorUserId !== null ? ` · #${row.actorUserId}` : ""}</TableCell>
              <TableCell className="hidden max-w-[16rem] truncate md:table-cell">{row.target}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>{t("settingsOps.details")}</Button>
              </TableCell>
            </TableRow>
            {open === row.id ? (
              <tr>
                <td colSpan={5} className="p-0">
                  <div className="row-expansion mb-1.5 grid gap-3 px-4 py-3 sm:grid-cols-2">
                    <p className="text-xs font-bold break-all text-muted-foreground sm:col-span-2 md:hidden">{t("settingsOps.target")} · {row.target}</p>
                    {(["before", "after"] as const).map((key) => (
                      <div key={key} className="min-w-0 rounded-[16px] bg-card p-3">
                        <h4 className="type-th mb-2">{t(`settingsOps.${key}`)}</h4>
                        <pre className="max-h-80 overflow-y-auto text-xs whitespace-pre-wrap break-all">{JSON.stringify(row[key], null, 2)}</pre>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            ) : null}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
