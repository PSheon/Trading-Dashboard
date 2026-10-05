"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { auditEvents, type AuditResponse } from "@/lib/contracts";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useI18n } from "@/i18n/provider";
import { Panel, PanelSkeleton } from "@/components/page";
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
  return <section className="space-y-4" aria-labelledby="audit-title">
    <h2 id="audit-title" className="text-lg font-semibold">{t("settingsOps.audit")}</h2>
    <p className="max-w-3xl text-sm text-muted-foreground">{t("settingsOps.auditHint")}</p>
    <Panel className="p-4"><form className="grid gap-4 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); setApplied({ ...filters, target: filters.target.trim() }); setCursors([]); }}>
      <div className="grid gap-2"><Label htmlFor="audit-event">{t("settingsOps.event")}</Label>
        <Select id="audit-event" className="w-full" value={filters.event} onValueChange={event => setFilters({ ...filters, event })} options={[{ value: "", label: t("settingsOps.all") }, ...auditEvents.map(event => ({ value: event, label: event }))]} /></div>
      <div className="grid gap-2"><Label htmlFor="audit-actor">{t("settingsOps.actorKind")}</Label>
        <Select id="audit-actor" className="w-full" value={filters.actorKind} onValueChange={actorKind => setFilters({ ...filters, actorKind })} options={[{ value: "", label: t("settingsOps.all") }, ...(["user", "service", "system"] as const).map(kind => ({ value: kind, label: t(`settingsOps.${kind}`) }))]} /></div>
      <div className="grid gap-2"><Label htmlFor="audit-user">{t("settingsOps.actorUserId")}</Label><Input id="audit-user" type="number" min={1} max={2147483647} step={1} value={filters.actorUserId} onChange={e => setFilters({ ...filters, actorUserId: e.target.value })} /></div>
      <div className="grid gap-2"><Label htmlFor="audit-target">{t("settingsOps.target")}</Label><Input id="audit-target" maxLength={256} value={filters.target} onChange={e => setFilters({ ...filters, target: e.target.value })} /></div>
      <div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="submit">{t("settingsOps.search")}</Button><Button type="button" variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("settingsOps.refresh")}</Button></div>
    </form></Panel>
    {query.isError ? <p role="alert" className="text-warning">{t("settingsOps.failed")}</p> : query.data ? <AuditEntries items={query.data.items} /> : <PanelSkeleton rows={5} />}
    <div className="flex flex-wrap items-center justify-between gap-3"><Button variant="secondary" disabled={!cursors.length || query.isFetching} onClick={() => setCursors(cursors.slice(0, -1))}>{t("settingsOps.previous")}</Button><p className="text-xs">{t("settingsOps.page", { page: cursors.length + 1 })}</p><Button variant="secondary" disabled={!query.data?.nextCursor || query.isFetching || query.isError} onClick={() => setCursors([...cursors, query.data!.nextCursor!])}>{t("settingsOps.next")}</Button></div>
  </section>;
}
export function AuditEntries({ items }: { items: AuditResponse["items"] }) {
  const { t, format } = useI18n();
  if (!items.length) return <Panel className="p-5 text-sm text-muted-foreground">{t("settingsOps.empty")}</Panel>;
  return <div className="space-y-3">{items.map(row => <Panel key={row.id} className="min-w-0 space-y-3 p-4">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="break-all text-sm font-semibold">{row.event} · #{row.id}</h3><time className="text-xs text-muted-foreground" dateTime={row.createdAt}>{format.dateTime(row.createdAt)}</time></div>
    <dl className="grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-muted-foreground">{t("settingsOps.actorKind")}</dt><dd>{t(`settingsOps.${row.actorKind}`)}{row.actorUserId !== null ? ` · #${row.actorUserId}` : ""}</dd></div><div><dt className="text-muted-foreground">{t("settingsOps.target")}</dt><dd className="break-all">{row.target}</dd></div></dl>
    <details><summary className="cursor-pointer text-xs font-medium">{t("settingsOps.details")}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{(["before", "after"] as const).map(key => <div key={key} className="min-w-0 rounded-lg bg-raised p-3"><h4 className="mb-2 text-xs text-muted-foreground">{t(`settingsOps.${key}`)}</h4><pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(row[key], null, 2)}</pre></div>)}</div></details>
  </Panel>)}</div>;
}
