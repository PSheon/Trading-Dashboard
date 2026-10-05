"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { ZodTypeAny } from "zod";
import { cn } from "cn";

import { ErrorState, PanelSkeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TIME_ZONE_LABEL } from "@/i18n/config";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";
import { usePermission } from "@/lib/auth";
import {
  activeWithinSchema,
  discoverySettingsSchema,
  generalSettingsSchema,
  notificationSettingsSchema,
  revenueSettingsSchema,
  type AdminSettings,
  type AdminSettingsSnapshot,
  type AdminSystemOverview,
  type PatchAdminSettingsRequest,
} from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";
import { MarketChips } from "./market-chips";
import { DefaultRulesEditor } from "./rules";
import { AdminCard, Notice } from "./ui";

type Section = keyof AdminSettings;
const SECTIONS: Section[] = ["general", "discovery", "notifications", "revenue"];

const SCHEMAS: Record<Section, ZodTypeAny> = {
  general: generalSettingsSchema,
  discovery: discoverySettingsSchema,
  notifications: notificationSettingsSchema,
  revenue: revenueSettingsSchema,
};

type Drafts = { [S in Section]: { original: AdminSettings[S]; value: AdminSettings[S]; revision: string } };
const draftsOf = (d: AdminSettingsSnapshot): Drafts => ({
  general: { original: d.general, value: d.general, revision: d.revisions.general },
  discovery: { original: d.discovery, value: d.discovery, revision: d.revisions.discovery },
  notifications: { original: d.notifications, value: d.notifications, revision: d.revisions.notifications },
  revenue: { original: d.revenue, value: d.revenue, revision: d.revisions.revenue },
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The fields of a section that differ from what was loaded. */
const changedFields = <S extends Section>(draft: Drafts[S]) =>
  Object.entries(draft.value as Record<string, unknown>).filter(([key, field]) => !same(field, (draft.original as Record<string, unknown>)[key]));

/**
 * 設定 (C-AdminNew-Settings): 一般 / 探索 / 通知 (with the default alert
 * rules, the old 預設規則 page) / 收入, the deployment's read-only tuning
 * under 進階, and one 儲存後的變更 card that lists every pending change and
 * saves the touched sections together (each with its revision; a section
 * someone else saved meanwhile is a 409 to reload).
 */
export function AdminSettingsForm() {
  const settings = useQuery({
    queryKey: queryKeys.admin.settings,
    queryFn: ({ signal }) => api.get<AdminSettingsSnapshot>("/admin/settings", signal),
    refetchInterval: false,
  });
  if (settings.isError && !settings.data) return <AdminCard><ErrorState message={settings.error.message} onRetry={() => settings.refetch()} /></AdminCard>;
  if (!settings.data) return <div className="grid gap-4 lg:grid-cols-2"><PanelSkeleton fields={6} /><PanelSkeleton fields={6} /></div>;
  return <SettingsEditor snapshot={settings.data} stale={settings.isError} />;
}

function SettingsEditor({ snapshot, stale }: { snapshot: AdminSettingsSnapshot; stale: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const canSave = usePermission("settings.write");
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(snapshot));
  // A fresh snapshot (another tab's save, a reload) replaces the sections not being edited.
  const [seen, setSeen] = useState(snapshot);
  if (seen !== snapshot) {
    setSeen(snapshot);
    setDrafts((previous) => {
      const next = draftsOf(snapshot);
      return Object.fromEntries(SECTIONS.map((s) => [s, changedFields(previous[s]).length ? previous[s] : next[s]])) as Drafts;
    });
  }
  const [clientError, setClientError] = useState<string>();
  const [asking, setAsking] = useState<{ title: string; body: string } | null>(null);

  const set = <S extends Section>(section: S, patch: Partial<AdminSettings[S]>) =>
    setDrafts((d) => ({ ...d, [section]: { ...d[section], value: { ...d[section].value, ...patch } } }));
  const dirty = SECTIONS.filter((s) => changedFields(drafts[s]).length > 0);

  const save = useMutation<AdminSettingsSnapshot, ApiError, PatchAdminSettingsRequest>({
    mutationFn: (body) => api.patch<AdminSettingsSnapshot>("/admin/settings", body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.admin.settings, data);
      setSeen(data);
      setDrafts(draftsOf(data));
      void queryClient.invalidateQueries({ queryKey: queryKeys.siteSettings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.settingsRuntime });
    },
  });
  const reload = useMutation({
    mutationFn: () => api.get<AdminSettingsSnapshot>("/admin/settings"),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.admin.settings, data);
      setSeen(data);
      setDrafts(draftsOf(data));
      setClientError(undefined);
      save.reset();
    },
  });

  function send(confirmed: boolean) {
    if (!canSave || !dirty.length) return;
    const body: PatchAdminSettingsRequest = { expectedRevisions: {} };
    for (const section of dirty) {
      const parsed = SCHEMAS[section].safeParse(drafts[section].value);
      if (!parsed.success) {
        setClientError(parsed.error.issues.map((i) => `${i.path.join(".") || section}: ${i.message}`).join("; "));
        return;
      }
      const original = drafts[section].original as Record<string, unknown>;
      (body as Record<string, unknown>)[section] = Object.fromEntries(Object.entries(parsed.data as Record<string, unknown>).filter(([key, field]) => !same(field, original[key])));
      body.expectedRevisions![section] = drafts[section].revision;
    }
    setClientError(undefined);
    // Switching maintenance on or off is confirmed; editing its text is not.
    const g = drafts.general;
    if (!confirmed && g.value.maintenance.enabled !== g.original.maintenance.enabled) {
      setAsking(g.value.maintenance.enabled
        ? { title: t("adminOps.maintenance.confirmOnTitle"), body: t("adminOps.maintenance.confirmOn") }
        : { title: t("adminOps.maintenance.confirmOffTitle"), body: t("adminOps.maintenance.confirmOff") });
      return;
    }
    setAsking(null);
    save.mutate(body);
  }

  const disabled = !canSave || save.isPending || reload.isPending;
  return (
    <div className="flex flex-col gap-4">
      {stale ? <Notice>{t("admin.settings.failed", { message: "" })}</Notice> : null}
      {snapshot.invalidSections.length ? <Notice>{t("admin.settings.invalid", { sections: snapshot.invalidSections.join(", ") })}</Notice> : null}
      {!canSave ? <p className="type-caption">{t("admin.settings.readOnly")}</p> : null}
      <fieldset disabled={disabled} className="contents">
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <GeneralCard draft={drafts.general} set={(p) => set("general", p)} />
            <NotificationsCard draft={drafts.notifications} set={(p) => set("notifications", p)} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <DiscoveryCard draft={drafts.discovery} set={(p) => set("discovery", p)} disabled={disabled} />
            <RevenueCard draft={drafts.revenue} set={(p) => set("revenue", p)} />
          </div>
        </div>
      </fieldset>
      <AdvancedCard />
      <AdminCard
        aria-labelledby="settings-changes-title"
        title={<span id="settings-changes-title">{t("admin.settings.changesTitle")}</span>}
        action={canSave ? (
          <span className="flex gap-2">
            <Button variant="secondary" disabled={!dirty.length || save.isPending} onClick={() => { setDrafts(draftsOf(snapshot)); setClientError(undefined); save.reset(); }}>{t("admin.settings.discard")}</Button>
            <Button disabled={!dirty.length || disabled || save.error?.status === 409} onClick={() => send(false)}>{save.isPending ? t("common.saving") : t("admin.settings.save")}</Button>
          </span>
        ) : null}
      >
        {dirty.length ? <Changes drafts={drafts} sections={dirty} /> : save.isSuccess ? (
          <p role="status" className="flex items-center gap-1.5 text-sm font-bold text-positive"><Check className="size-4" />{t("admin.settings.saved")}</p>
        ) : <p className="type-caption">{t("admin.settings.noChanges")}</p>}
        {clientError || save.isError || reload.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[22px] bg-tag-loss px-4 py-3 text-sm font-bold text-tag-loss-foreground">
            <span>{save.error?.status === 409 ? t("admin.settings.conflict") : t("admin.settings.failed", { message: clientError ?? reload.error?.message ?? save.error?.message ?? "" })}</span>
            {save.error?.status === 409 ? <Button size="sm" variant="secondary" disabled={reload.isPending} onClick={() => reload.mutate()}>{t("admin.settings.reload")}</Button> : null}
          </div>
        ) : null}
      </AdminCard>
      <Modal open={asking !== null} onOpenChange={(open) => { if (!open) setAsking(null); }} title={asking?.title ?? ""}>
        <p className="text-sm leading-relaxed text-muted-foreground">{asking?.body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setAsking(null)}>{t("adminOps.maintenance.cancel")}</Button>
          <Button type="button" onClick={() => send(true)}>{t("adminOps.maintenance.confirm")}</Button>
        </div>
      </Modal>
    </div>
  );
}

/** "每位使用者的警報上限 3 → 5": every pending change, before and after. */
function Changes({ drafts, sections }: { drafts: Drafts; sections: Section[] }) {
  const { t } = useI18n();
  const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <dl className="divide-y-2 divide-dotted divide-border" aria-label={t("admin.settings.changesTitle")}>
      {sections.flatMap((section) => changedFields(drafts[section]).map(([key, value]) => (
        <div key={`${section}.${key}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
          <dt className="text-[15px] font-extrabold">{t(`settingsOps.fields.${key}` as MessageKey)}</dt>
          <dd className="num min-w-0 max-w-full text-right text-sm font-extrabold break-words">
            <span className="text-muted-foreground">{show((drafts[section].original as Record<string, unknown>)[key])}</span> → {show(value)}
          </dd>
        </div>
      )))}
    </dl>
  );
}

/** An ISO instant as the value of a datetime-local input and back. The field
 * is read and written in UTC, like every time on the site; its label says so. */
export function toUtcInput(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toISOString().slice(0, 16);
}
export function fromUtcInput(value: string): string | null {
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? new Date(`${value}Z`) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
}

/** A labelled on / off switch (the board's orange track). */
function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (next: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="min-w-0">
        <span className="block text-[15px] font-extrabold">{label}</span>
        {hint ? <span className="type-caption mt-0.5 block">{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn("relative h-8 w-[52px] shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", checked ? "bg-primary" : "bg-inset shadow-[inset_0_0_0_2px_var(--border)]")}
      >
        <span className={cn("absolute top-1 size-6 rounded-full bg-card shadow-sm transition-[left] motion-reduce:transition-none", checked ? "left-[24px]" : "left-1")} />
      </button>
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id} className="type-th">{label}</Label>
      {children}
      {hint ? <p className="type-caption">{hint}</p> : null}
    </div>
  );
}

function GeneralCard({ draft, set }: { draft: Drafts["general"]; set: (patch: Partial<AdminSettings["general"]>) => void }) {
  const { t } = useI18n();
  const value = draft.value;
  const setAnnouncement = (patch: Partial<AdminSettings["general"]["announcement"]>) => set({ announcement: { ...value.announcement, ...patch } });
  const setMaintenance = (patch: Partial<AdminSettings["general"]["maintenance"]>) => set({ maintenance: { ...value.maintenance, ...patch } });
  return (
    <AdminCard id="general" className="scroll-mt-24" title={t("admin.settings.general.title")}>
      <Toggle label={t("admin.settings.general.announcement")} checked={value.announcement.enabled} onChange={(enabled) => setAnnouncement({ enabled })} />
      <div className="grid gap-3 sm:grid-cols-2">
        {(["zh-TW", "en"] as const).map((l) => (
          <Field key={l} id={`announcement-${l}`} label={t(l === "zh-TW" ? "admin.settings.general.announcementZh" : "admin.settings.general.announcementEn")}
            hint={<span className="num">{value.announcement.text[l].length}/280</span>}>
            <Textarea id={`announcement-${l}`} rows={2} maxLength={280} value={value.announcement.text[l]} className="font-sans text-sm"
              onChange={(e) => setAnnouncement({ text: { ...value.announcement.text, [l]: e.target.value } })} />
          </Field>
        ))}
      </div>
      <Toggle label={t("admin.settings.general.signupsOpen")} hint={t("admin.settings.general.signupsHint")} checked={value.signupsOpen} onChange={(signupsOpen) => set({ signupsOpen })} />
      <Toggle label={t("admin.settings.general.copyTrading")} hint={t("admin.settings.general.copyTradingHint")} checked={value.copyTradingEnabled} onChange={(copyTradingEnabled) => set({ copyTradingEnabled })} />
      <Toggle label={t("adminOps.maintenance.toggle")} hint={t("adminOps.maintenance.hint")} checked={value.maintenance.enabled} onChange={(enabled) => setMaintenance({ enabled })} />
      {draft.original.maintenance.enabled ? <span className="chip-md self-start bg-tag-warning text-tag-warning-foreground">{t("adminOps.maintenance.active")}</span> : null}
      <div className={cn("grid gap-3 rounded-[22px] bg-inset p-3.5 sm:grid-cols-2", draft.original.maintenance.enabled && "shadow-[0_0_0_2px_var(--warning)]")}>
        {(["zh-TW", "en"] as const).map((l) => (
          <Field key={l} id={`maintenance-${l}`} label={t(l === "zh-TW" ? "adminOps.maintenance.messageZh" : "adminOps.maintenance.messageEn")}>
            <Textarea id={`maintenance-${l}`} rows={2} maxLength={280} value={value.maintenance.message[l]} className="bg-card font-sans text-sm"
              onChange={(e) => setMaintenance({ message: { ...value.maintenance.message, [l]: e.target.value } })} />
          </Field>
        ))}
        <Field id="maintenance-ends" label={`${t("adminOps.maintenance.endsAt")} (${TIME_ZONE_LABEL})`} hint={t("adminOps.maintenance.endsAtHint")}>
          <Input id="maintenance-ends" type="datetime-local" className="bg-card" value={toUtcInput(value.maintenance.endsAt)} onChange={(e) => setMaintenance({ endsAt: fromUtcInput(e.target.value) })} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="max-favorites" label={t("adminOps.settings.maxFavorites")} hint={t("adminOps.settings.maxFavoritesHint")}>
          <Input id="max-favorites" type="number" min={1} max={10000} placeholder={t("admin.settings.unlimited")} value={value.maxFavoritesPerUser ?? ""}
            onChange={(e) => set({ maxFavoritesPerUser: e.target.value === "" ? null : Number(e.target.value) })} />
        </Field>
        <Field id="max-watched" label={t("adminOps.settings.maxWatched")} hint={t("adminOps.settings.maxWatchedHint")}>
          <Input id="max-watched" type="number" min={1} max={100000} value={value.maxWatchedAddresses}
            onChange={(e) => { const next = Number(e.target.value); if (Number.isInteger(next) && next >= 1) set({ maxWatchedAddresses: next }); }} />
        </Field>
      </div>
    </AdminCard>
  );
}

function DiscoveryCard({ draft, set, disabled }: { draft: Drafts["discovery"]; set: (patch: Partial<AdminSettings["discovery"]>) => void; disabled: boolean }) {
  const { t } = useI18n();
  const value = draft.value;
  return (
    <AdminCard id="discovery" className="scroll-mt-24" title={t("admin.settings.discovery.title")}>
      <MarketChips id="home-markets" kind="any" label={t("admin.settings.discovery.homeMarkets")} hint={t("admin.settings.discovery.homeMarketsHint")}
        value={value.homeMarkets} onChange={(homeMarkets) => set({ homeMarkets })} disabled={disabled} />
      <Toggle label={t("admin.settings.discovery.hideVaults")} checked={value.hideVaults} onChange={(hideVaults) => set({ hideVaults })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="low-sample" label={t("admin.settings.discovery.lowSample")}>
          <Input id="low-sample" type="number" min={0} max={1000} value={value.lowSampleThreshold} onChange={(e) => set({ lowSampleThreshold: Number(e.target.value) })} />
        </Field>
        <Field id="active-within" label={t("admin.settings.discovery.defaultActiveWithin")} hint={t("admin.settings.discovery.defaultActiveWithinHint")}>
          <Select id="active-within" className="w-full" value={value.defaultActiveWithin} disabled={disabled}
            onValueChange={(defaultActiveWithin) => set({ defaultActiveWithin })}
            options={activeWithinSchema.options.map((a) => ({ value: a, label: t(`admin.settings.discovery.activeOptions.${a}`) }))} />
        </Field>
      </div>
      <MarketChips id="crypto-boards" kind="crypto" label={t("settingsOps.cryptoBoards")} value={value.cryptoBoards} onChange={(cryptoBoards) => set({ cryptoBoards })} disabled={disabled} />
      <MarketChips id="stock-boards" kind="stocks" label={t("settingsOps.stockBoards")} value={value.stockBoards} onChange={(stockBoards) => set({ stockBoards })} disabled={disabled} />
    </AdminCard>
  );
}

function NotificationsCard({ draft, set }: { draft: Drafts["notifications"]; set: (patch: Partial<AdminSettings["notifications"]>) => void }) {
  const { t } = useI18n();
  const [rules, setRules] = useState(false);
  const canRules = usePermission("rules.read");
  const value = draft.value;
  return (
    <AdminCard id="notifications" className="scroll-mt-24" title={t("admin.settings.notifications.title")}>
      <Toggle label={t("admin.settings.notifications.alertsEnabled")} hint={t("admin.settings.notifications.alertsHint")} checked={value.alertsEnabled} onChange={(alertsEnabled) => set({ alertsEnabled })} />
      <Field id="max-alert-traders" label={t("admin.settings.notifications.maxAlertTraders")} hint={t("admin.settings.notifications.maxAlertTradersHint")}>
        <Input id="max-alert-traders" type="number" min={1} max={1000} value={value.maxAlertTraders} onChange={(e) => set({ maxAlertTraders: Number(e.target.value) })} />
      </Field>
      {canRules ? (
        <div className="flex items-center justify-between gap-3 rounded-[22px] bg-inset py-2 pr-2 pl-4">
          <span className="text-[15px] font-extrabold">{t("admin.settings.notifications.defaultRules")}</span>
          {/* Outside the form's fieldset: the rules save on their own. */}
          <Button type="button" variant="secondary" size="sm" className="bg-card" onClick={() => setRules(true)}>{t("admin.settings.notifications.editRules")}</Button>
        </div>
      ) : null}
      <Drawer open={rules} onOpenChange={setRules} title={t("admin.rules.title")}>
        <DefaultRulesEditor />
      </Drawer>
    </AdminCard>
  );
}

function RevenueCard({ draft, set }: { draft: Drafts["revenue"]; set: (patch: Partial<AdminSettings["revenue"]>) => void }) {
  const { t, format } = useI18n();
  const value = draft.value;
  const [feeInput, setFeeInput] = useState({ revision: draft.revision, text: String(draft.original.builderFeeTenthsBps / 1000) });
  if (feeInput.revision !== draft.revision) setFeeInput({ revision: draft.revision, text: String(draft.original.builderFeeTenthsBps / 1000) });
  return (
    <AdminCard id="revenue" className="scroll-mt-24" title={t("admin.settings.revenue.title")}>
      <Field id="builder-address" label={t("admin.settings.revenue.address")} hint={t("admin.settings.revenue.addressHint")}>
        <Input id="builder-address" value={value.builderAddress ?? ""} placeholder="0x…" className="font-mono"
          onChange={(e) => set({ builderAddress: e.target.value.trim() ? e.target.value.trim().toLowerCase() : null })} />
      </Field>
      <Field id="builder-fee" label={t("admin.settings.revenue.fee")}
        hint={<span className="num">{t("admin.settings.revenue.feeHint", { tenths: Number.isFinite(value.builderFeeTenthsBps) ? format.num(value.builderFeeTenthsBps, 0) : "—" })}</span>}>
        <Input id="builder-fee" inputMode="decimal" value={feeInput.text}
          onChange={(e) => {
            setFeeInput({ revision: draft.revision, text: e.target.value });
            const pct = Number(e.target.value);
            set({ builderFeeTenthsBps: Number.isFinite(pct) ? Math.round(pct * 1000) : Number.NaN });
          }} />
      </Field>
    </AdminCard>
  );
}

/** 進階: what moved to the environment (2026-10-05), read-only, from the worker. */
function AdvancedCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const canSystem = usePermission("admin.access");
  const system = useQuery({ queryKey: queryKeys.adminSystem, queryFn: ({ signal }) => api.get<AdminSystemOverview>("/admin/system/overview", signal), enabled: canSystem, refetchInterval: 60_000 });
  const tuning = system.data?.worker.sample?.tuning ?? system.data?.api.tuning;
  const chip = (text: string) => <span key={text} className="chip-md bg-inset">{text}</span>;
  return (
    <AdminCard
      title={t("admin.settings.advancedTitle")}
      action={<Button variant="secondary" aria-expanded={open} aria-controls="settings-advanced" onClick={() => setOpen((v) => !v)}>{t(open ? "admin.settings.collapse" : "admin.settings.expand")}<ChevronDown className={cn("transition-transform", open && "rotate-180")} /></Button>}
    >
      {tuning ? (
        <div className="flex flex-wrap gap-2">
          {chip(t("admin.settings.tuning.pool", { size: tuning.discovery.candidatePoolSize }))}
          {chip(t("admin.settings.tuning.poolWeights", { ledger: tuning.weights.poolLedger, performance: tuning.weights.poolPerformance }))}
          {chip(t("admin.settings.tuning.historyWeights", { history: tuning.weights.history, backfill: tuning.weights.backfill }))}
          {chip(t("admin.settings.tuning.cohort", { weight: tuning.weights.cohort, members: tuning.discovery.cohortMembersPerTier, minutes: tuning.discovery.cohortRefreshMinutes }))}
          {chip(t("admin.settings.tuning.leaderboard", { minutes: tuning.discovery.leaderboardRefreshMinutes }))}
          {chip(tuning.retention.enabled ? t("admin.settings.tuning.retention", { snapshots: tuning.retention.snapshotDays, audit: tuning.retention.auditDays }) : t("admin.settings.tuning.retentionOff"))}
        </div>
      ) : <p className="type-caption">{system.isError ? t("monitoring.unavailable") : t("admin.settings.tuning.loading")}</p>}
      <div id="settings-advanced" hidden={!open}>
        {tuning ? (
          <dl className="grid gap-x-6 sm:grid-cols-2">
            {([
              ["HYPERLIQUID_POOL_LEDGER_WEIGHT_PER_MIN", tuning.weights.poolLedger], ["HYPERLIQUID_POOL_PERFORMANCE_WEIGHT_PER_MIN", tuning.weights.poolPerformance],
              ["HYPERLIQUID_HISTORY_WEIGHT_PER_MIN", tuning.weights.history], ["HYPERLIQUID_BACKFILL_WEIGHT_PER_MIN", tuning.weights.backfill],
              ["HYPERLIQUID_COHORT_WEIGHT_PER_MIN", tuning.weights.cohort], ["DISCOVERY_LEADERBOARD_REFRESH_MINUTES", tuning.discovery.leaderboardRefreshMinutes],
              ["DISCOVERY_CANDIDATE_POOL_SIZE", tuning.discovery.candidatePoolSize], ["DISCOVERY_COHORT_MEMBERS_PER_TIER", tuning.discovery.cohortMembersPerTier],
              ["DISCOVERY_COHORT_REFRESH_MINUTES", tuning.discovery.cohortRefreshMinutes], ["RETENTION_ENABLED", String(tuning.retention.enabled)],
              ["RETENTION_SNAPSHOT_DAYS", tuning.retention.snapshotDays], ["RETENTION_AUDIT_DAYS", tuning.retention.auditDays],
              ["RETENTION_ACCOUNT_DELETION_DAYS", tuning.retention.accountDeletionDays], ["RETENTION_QUEUE_DAYS", tuning.retention.queueDays],
              ["RETENTION_ALERT_DAYS", tuning.retention.alertDays],
            ] as const).map(([name, v]) => (
              <div key={name} className="flex items-center justify-between gap-3 border-b-2 border-dotted border-border py-2 text-sm">
                <dt className="min-w-0 truncate font-mono text-xs font-bold text-muted-foreground" title={name}>{name}</dt>
                <dd className="num font-extrabold">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <p className="type-caption">{t("admin.settings.advancedHint")}</p>
    </AdminCard>
  );
}
