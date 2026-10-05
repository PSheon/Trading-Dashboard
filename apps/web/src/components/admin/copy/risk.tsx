"use client";

import { useState } from "react";
import { copyRiskLimitsSchema, type CopyRiskLimits } from "@trading-dashboard/shared/contracts";

import { ErrorState, Panel, PanelSkeleton, SectionHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { useAdminCopyRisk, useSaveCopyRisk } from "@/lib/admin-copy";
import { usePermission } from "@/lib/auth";
import type { AdminCopyRiskView } from "@/lib/contracts";
import { Chip, CopyAdminNav } from "./shared";

type NumberField = Exclude<keyof CopyRiskLimits, "allowHip3" | "blockedCoins">;
/** Form order: the account, sizing caps, exposure caps, execution quality. */
const GROUPS: { title: MessageKey; fields: NumberField[] }[] = [
  { title: "copyAdmin.risk.groups.account", fields: ["paperStartingBalanceUsd", "minAllocationUsd", "maxAllocationUsd", "maxStrategiesPerUser"] },
  { title: "copyAdmin.risk.groups.orders", fields: ["maxLeverage", "minOrderNotionalUsd", "maxOrderNotionalUsd", "maxOrdersPerMinute"] },
  { title: "copyAdmin.risk.groups.exposure", fields: ["maxCoinExposureUsd", "maxUserExposureUsd"] },
  { title: "copyAdmin.risk.groups.execution", fields: ["maxSlippageBps", "simulatedSlippageBps", "takerFeeBps", "maxSignalAgeSeconds"] },
];
const NUMBER_FIELDS = GROUPS.flatMap((g) => g.fields);

type Draft = Record<NumberField, string> & { allowHip3: boolean; blockedCoins: string };
const toDraft = (limits: CopyRiskLimits): Draft => ({
  ...(Object.fromEntries(NUMBER_FIELDS.map((f) => [f, String(limits[f])])) as Record<NumberField, string>),
  allowHip3: limits.allowHip3,
  blockedCoins: limits.blockedCoins.join(", "),
});
/** The draft as the request's `limits`; an empty or non-numeric box becomes NaN, which the schema refuses. */
const toLimits = (draft: Draft) => ({
  ...Object.fromEntries(NUMBER_FIELDS.map((f) => [f, draft[f].trim() === "" ? Number.NaN : Number(draft[f])])),
  allowHip3: draft.allowHip3,
  blockedCoins: draft.blockedCoins.split(/[\s,]+/).filter(Boolean),
});

export function AdminCopyRisk() {
  const { t } = useI18n();
  const risk = useAdminCopyRisk();
  // Held here: a save replaces the policy, which remounts the form below.
  const save = useSaveCopyRisk();
  return (
    <div className="flex flex-col gap-5">
      <CopyAdminNav />
      {risk.isError && !risk.data ? <Panel><ErrorState message={risk.error.message} onRetry={() => risk.refetch()} /></Panel>
        : !risk.data ? <PanelSkeleton fields={8} />
        // A saved or reloaded version starts the form over from that version.
        : <RiskForm key={risk.data.version} policy={risk.data} save={save} onReload={() => { save.reset(); void risk.refetch(); }} reloading={risk.isFetching} />}
      <p className="max-w-3xl text-xs leading-relaxed text-subtle-foreground">{t("copyAdmin.risk.note")}</p>
    </div>
  );
}

function RiskForm({ policy, save, onReload, reloading }: { policy: AdminCopyRiskView; save: ReturnType<typeof useSaveCopyRisk>; onReload: () => void; reloading: boolean }) {
  const { t, format } = useI18n();
  const canManage = usePermission("risk.manage");
  const [draft, setDraft] = useState<Draft>(() => toDraft(policy.limits));
  const [reason, setReason] = useState("");
  const parsed = copyRiskLimitsSchema.safeParse(toLimits(draft));
  const errors = new Map(parsed.success ? [] : parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message] as const));
  const dirty = JSON.stringify(toDraft(policy.limits)) !== JSON.stringify(draft);
  const stale = save.isError && save.error.code === "stale_version";
  const ready = canManage && dirty && parsed.success && reason.trim().length >= 3 && !save.isPending;

  return (
    <>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !parsed.success) return;
          save.mutate({ limits: parsed.data, reason: reason.trim(), expectedVersion: policy.version });
        }}
      >
        <Panel className="flex flex-col gap-5 p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-lg font-bold">{t("copyAdmin.risk.title")}</h2>
            <Chip tone="info">{t("copyAdmin.risk.version", { version: policy.version })}</Chip>
            <span className="text-xs text-subtle-foreground">
              {policy.createdAt ? t("copyAdmin.risk.savedAt", { time: format.dateTime(policy.createdAt) }) : t("copyAdmin.risk.defaults")}
            </span>
          </div>
          {!canManage ? <p className="rounded-xl bg-raised px-3.5 py-2.5 text-sm text-muted-foreground">{t("copyAdmin.risk.readOnly")}</p> : null}
          {GROUPS.map((group) => (
            <fieldset key={group.title} className="grid gap-3" disabled={!canManage || save.isPending}>
              <legend className="mb-1 text-sm font-semibold">{t(group.title)}</legend>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {group.fields.map((field) => (
                  <div key={field} className="grid content-start gap-2">
                    <Label htmlFor={`risk-${field}`}>{t(`copyAdmin.risk.fields.${field}`)}</Label>
                    <Input
                      id={`risk-${field}`}
                      inputMode="decimal"
                      value={draft[field]}
                      aria-invalid={errors.has(field) || undefined}
                      aria-describedby={errors.has(field) ? `risk-${field}-error` : undefined}
                      onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                    />
                    {errors.has(field) ? <p id={`risk-${field}-error`} className="text-xs text-negative">{errors.get(field)}</p> : null}
                  </div>
                ))}
              </div>
            </fieldset>
          ))}
          <fieldset className="grid gap-3" disabled={!canManage || save.isPending}>
            <legend className="mb-1 text-sm font-semibold">{t("copyAdmin.risk.groups.markets")}</legend>
            <label className="flex items-center gap-2.5 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={draft.allowHip3} onChange={(event) => setDraft({ ...draft, allowHip3: event.target.checked })} />
              {t("copyAdmin.risk.fields.allowHip3")}
            </label>
            <div className="grid gap-2">
              <Label htmlFor="risk-blockedCoins">{t("copyAdmin.risk.fields.blockedCoins")}</Label>
              <Textarea id="risk-blockedCoins" rows={2} value={draft.blockedCoins} aria-invalid={errors.has("blockedCoins") || undefined}
                placeholder="kPEPE, xyz:TSLA" onChange={(event) => setDraft({ ...draft, blockedCoins: event.target.value })} />
              {errors.has("blockedCoins") ? <p className="text-xs text-negative">{errors.get("blockedCoins")}</p> : null}
            </div>
          </fieldset>
        </Panel>

        {canManage ? (
          <Panel className="flex flex-col gap-3 p-5">
            <div className="grid gap-2">
              <Label htmlFor="risk-reason">{t("copyAdmin.risk.reason")}</Label>
              <Textarea id="risk-reason" rows={2} maxLength={500} className="font-sans" value={reason} disabled={save.isPending}
                placeholder={t("copyAdmin.risk.reasonHint")} onChange={(event) => setReason(event.target.value)} />
            </div>
            {save.isSuccess && !dirty ? <p role="status" className="rounded-xl bg-positive-soft px-3.5 py-2.5 text-sm text-positive">{t("copyAdmin.risk.saved", { version: policy.version })}</p> : null}
            {save.isError ? (
              <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-negative-soft px-3.5 py-2.5 text-sm text-negative">
                <span>{stale ? t("copyAdmin.risk.stale") : t("copyAdmin.risk.failed", { message: save.error.message })}</span>
                {stale ? <Button type="button" size="sm" variant="secondary" disabled={reloading} onClick={onReload}>{t("copyAdmin.risk.reload")}</Button> : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!ready}>{save.isPending ? t("common.saving") : t("copyAdmin.risk.save", { version: policy.version + 1 })}</Button>
              <Button type="button" variant="secondary" disabled={!dirty || save.isPending} onClick={() => { setDraft(toDraft(policy.limits)); save.reset(); }}>{t("copyAdmin.risk.reset")}</Button>
              {!dirty ? <span className="text-xs text-subtle-foreground">{t("copyAdmin.risk.unchanged")}</span> : null}
            </div>
          </Panel>
        ) : null}
      </form>

      <section>
        <SectionHeader title={t("copyAdmin.risk.history")} />
        <Panel className="overflow-hidden">
          {policy.history.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.risk.noHistory")}</p> : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.detail.versionCol")}</TableHead>
                  <TableHead>{t("copyAdmin.cols.reason")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("copyAdmin.cols.actor")}</TableHead>
                  <TableHead className="text-right">{t("copyAdmin.cols.time")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {policy.history.map((h) => (
                  <TableRow key={h.version}>
                    <TableCell className="font-semibold">v{h.version}{h.version === policy.version ? ` · ${t("copyAdmin.risk.current")}` : ""}</TableCell>
                    <TableCell className="min-w-[10rem] text-muted-foreground">{h.reason ?? "—"}</TableCell>
                    <TableCell className="hidden sm:table-cell">{h.createdByUserId === null ? "—" : `#${h.createdByUserId}`}</TableCell>
                    <TableCell className="whitespace-nowrap text-right text-muted-foreground">{format.dateTime(h.createdAt)}</TableCell>
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
