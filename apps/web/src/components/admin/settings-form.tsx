"use client";
import { SettingsRuntimePanel, SettingsImpact } from "./settings-operations";
import { queryKeys } from "@/lib/query-keys";
import { usePermission } from "@/lib/auth";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activeWithinSchema,
  addressSchema,
  discoverySettingsSchema,
  generalSettingsSchema,
  notificationSettingsSchema,
  revenueSettingsSchema,
  type AdminSettings,
  type AdminSettingsSnapshot,
  type PatchAdminSettingsRequest,
} from "@/lib/contracts";
import { ArrowDown, ArrowUp, Check, Plus, X } from "lucide-react";
import { useState, type SetStateAction } from "react";
import type { ZodTypeAny } from "zod";
import { cn } from "cn";

import { ErrorState, Panel, Skeleton } from "@/components/page";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import { api, type ApiError } from "@/lib/api";

type Section = keyof AdminSettings;
const MAX_FEATURED = 12;

const SCHEMAS: Record<Section, ZodTypeAny> = {
  general: generalSettingsSchema,
  discovery: discoverySettingsSchema,
  notifications: notificationSettingsSchema,
  revenue: revenueSettingsSchema,
};

/** Site settings: one form per section; each saves only its own section
 * (PATCH /admin/settings), validated client-side with the shared schema. */
export function AdminSettingsForm() {
  const { t } = useI18n();
  const settings = useQuery({
    queryKey: queryKeys.admin.settings,
    queryFn: ({ signal }) => api.get<AdminSettingsSnapshot>("/admin/settings", signal),
    refetchInterval: false,
  });

  if (settings.isError && !settings.data) {
    return (
      <Panel>
        <ErrorState message={settings.error.message} onRetry={() => settings.refetch()} />
      </Panel>
    );
  }
  if (!settings.data) return <Skeleton className="h-[480px] rounded-2xl" />;

  const d = settings.data;
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {settings.isError ? <p role="alert" className="text-sm text-negative">{t("admin.settings.failed", { message: settings.error.message })}</p> : null}
      <div role="status">{d.invalidSections.length ? t("admin.settings.invalid", { sections: d.invalidSections.join(", ") }) : null}</div>
      <SettingsRuntimePanel />
      <GeneralForm value={d.general} revision={d.revisions.general} />
      <DiscoveryForm value={d.discovery} revision={d.revisions.discovery} />
      <NotificationsForm value={d.notifications} revision={d.revisions.notifications} />
      <RevenueForm value={d.revenue} revision={d.revisions.revenue} />
    </div>
  );
}

/** Keep the exact baseline of an edited form, even when another section refreshes. */
function useSectionDraft<S extends Section>(incoming: AdminSettings[S], incomingRevision: string) {
  const [draft, setDraft] = useState({ original: incoming, value: incoming, revision: incomingRevision });
  if (draft.revision !== incomingRevision && JSON.stringify(draft.value) === JSON.stringify(draft.original)) {
    setDraft({ original: incoming, value: incoming, revision: incomingRevision });
  }
  return {
    ...draft,
    setValue: (action: SetStateAction<AdminSettings[S]>) => setDraft(previous => ({ ...previous,
      value: typeof action === "function" ? action(previous.value) : action,
    })),
    accept: (value: AdminSettings[S], revision: string) => setDraft({ original: value, value, revision }),
  };
}

function useSaveSection<S extends Section>(section: S) {
  const queryClient = useQueryClient();
  return useMutation<AdminSettingsSnapshot, ApiError, { patch: Partial<AdminSettings[S]>; revision: string }>({
    mutationFn: ({ patch, revision }) =>
      api.patch<AdminSettingsSnapshot>("/admin/settings", {
        [section]: patch, expectedRevisions: { [section]: revision },
      } as PatchAdminSettingsRequest),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.admin.settings, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.siteSettings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.settingsRuntime });
    },
  });
}

function FormCard<S extends Section>({
  id,
  title,
  section,
  value,
  original,
  revision,
  onSaved,
  confirm,
  children,
}: {
  id: string;
  title: string;
  section: S;
  value: AdminSettings[S];
  original: AdminSettings[S];
  revision: string;
  onSaved: (value: AdminSettings[S], revision: string) => void;
  /** A change that must be confirmed before it is sent (maintenance on / off): the dialog's title and text. */
  confirm?: (value: AdminSettings[S], original: AdminSettings[S]) => { title: string; body: string } | null;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const save = useSaveSection(section);
  const queryClient = useQueryClient();
  const reload = useMutation({
    mutationFn: () => api.get<AdminSettingsSnapshot>("/admin/settings"),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.admin.settings, data);
      onSaved(data[section], data.revisions[section]);
      setClientError(undefined);
      save.reset();
    },
  });
  const canSave = usePermission("settings.write");
  const [clientError, setClientError] = useState<string>();
  const [asking, setAsking] = useState<{ title: string; body: string } | null>(null);
  const dirty = JSON.stringify(value) !== JSON.stringify(original);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    send(false);
  }

  function send(confirmed: boolean) {
    if (!canSave) return;
    const parsed = SCHEMAS[section].safeParse(value);
    if (!parsed.success) {
      setClientError(
        parsed.error.issues.map((i) => `${i.path.join(".") || section}: ${i.message}`).join("; "),
      );
      return;
    }
    setClientError(undefined);
    const question = confirmed ? null : confirm?.(parsed.data as AdminSettings[S], original) ?? null;
    if (question) {
      setAsking(question);
      return;
    }
    setAsking(null);
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([key, field]) =>
      JSON.stringify(field) !== JSON.stringify((original as Record<string, unknown>)[key]),
    )) as Partial<AdminSettings[S]>;
    save.mutate({ patch, revision }, { onSuccess: data => onSaved(data[section], data.revisions[section]) });
  }

  return (
    <Panel id={id} className="scroll-mt-24 p-5 md:p-6">
      <form onSubmit={submit} className="flex flex-col gap-5">
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
        <fieldset disabled={!canSave || save.isPending || reload.isPending} className="contents">{children}</fieldset>
        {dirty && <SettingsImpact section={section} original={original} value={value} />}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
          {clientError || save.isError || reload.isError ? (
            <p role="alert" className="mr-auto text-xs text-negative">
              {save.error?.status === 409 ? t("admin.settings.conflict") : t("admin.settings.failed", { message: clientError ?? reload.error?.message ?? save.error?.message ?? "" })}
            </p>
          ) : dirty ? (
            <p className="mr-auto text-xs text-warning">{t("admin.settings.unsaved")}</p>
          ) : save.isSuccess ? (
            <p className="mr-auto flex items-center gap-1 text-xs text-positive">
              <Check className="size-3.5" />
              {t("admin.settings.saved")}
            </p>
          ) : null}
          {save.error?.status === 409 ? <Button type="button" variant="secondary" disabled={reload.isPending} onClick={() => reload.mutate()}>{t("admin.settings.reload")}</Button> : null}
          <Button type="submit" disabled={!canSave || !dirty || save.isPending || reload.isPending || save.error?.status === 409}>
            {save.isPending ? t("common.saving") : t("admin.settings.saveSection")}
          </Button>
        </div>
      </form>
      <Modal open={asking !== null} onOpenChange={(open) => { if (!open) setAsking(null); }} title={asking?.title ?? ""}>
        <p className="text-sm leading-relaxed text-muted-foreground">{asking?.body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setAsking(null)}>{t("adminOps.maintenance.cancel")}</Button>
          <Button type="button" onClick={() => send(true)}>{t("adminOps.maintenance.confirm")}</Button>
        </div>
      </Modal>
    </Panel>
  );
}

/** An ISO instant as the value of a datetime-local input (the admin's own time zone), and back. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function fromLocalInput(value: string): string | null {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked ? "bg-primary" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-5 rounded-full bg-foreground transition-[left]",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}

function GeneralForm({ value: incoming, revision: incomingRevision }: { value: AdminSettings["general"]; revision: string }) {
  const { t } = useI18n();
  const { value, original, revision, setValue, accept } = useSectionDraft<"general">(incoming, incomingRevision);
  const set = (patch: Partial<AdminSettings["general"]>) => setValue((v) => ({ ...v, ...patch }));
  const setAnnouncement = (patch: Partial<AdminSettings["general"]["announcement"]>) =>
    set({ announcement: { ...value.announcement, ...patch } });
  const setMaintenance = (patch: Partial<AdminSettings["general"]["maintenance"]>) =>
    set({ maintenance: { ...value.maintenance, ...patch } });
  // Switching maintenance on or off is confirmed; editing its text is not.
  const confirm = (next: AdminSettings["general"], before: AdminSettings["general"]) =>
    next.maintenance.enabled === before.maintenance.enabled ? null
      : next.maintenance.enabled ? { title: t("adminOps.maintenance.confirmOnTitle"), body: t("adminOps.maintenance.confirmOn") }
      : { title: t("adminOps.maintenance.confirmOffTitle"), body: t("adminOps.maintenance.confirmOff") };

  return (
    <FormCard id="general" title={t("admin.settings.general.title")} section="general" value={value} original={original} revision={revision} onSaved={accept} confirm={confirm}>
      <div className="flex flex-col gap-3 rounded-xl bg-raised/50 p-4">
        <Toggle
          label={t("admin.settings.general.announcement")}
          checked={value.announcement.enabled}
          onChange={(enabled) => setAnnouncement({ enabled })}
        />
        <div className="grid gap-3 md:grid-cols-2">
          {(["zh-TW", "en"] as const).map((l) => (
            <div key={l} className="grid gap-2">
              <Label htmlFor={`announcement-${l}`}>
                {t(l === "zh-TW" ? "admin.settings.general.announcementZh" : "admin.settings.general.announcementEn")}
              </Label>
              <Textarea
                id={`announcement-${l}`}
                rows={3}
                maxLength={280}
                value={value.announcement.text[l]}
                onChange={(e) => setAnnouncement({ text: { ...value.announcement.text, [l]: e.target.value } })}
                className="font-sans text-sm"
              />
              <span className="num text-right text-[11px] text-subtle-foreground">
                {value.announcement.text[l].length}/280
              </span>
            </div>
          ))}
        </div>
      </div>
      <Toggle
        label={t("admin.settings.general.signupsOpen")}
        hint={t("admin.settings.general.signupsHint")}
        checked={value.signupsOpen}
        onChange={(signupsOpen) => set({ signupsOpen })}
      />
      <Toggle
        label={t("admin.settings.general.copyTrading")}
        hint={t("admin.settings.general.copyTradingHint")}
        checked={value.copyTradingEnabled}
        onChange={(copyTradingEnabled) => set({ copyTradingEnabled })}
      />
      <div className="grid max-w-xs gap-2">
        <Label htmlFor="max-favorites">{t("adminOps.settings.maxFavorites")}</Label>
        <Input
          id="max-favorites"
          type="number"
          min={1}
          max={10000}
          value={value.maxFavoritesPerUser ?? ""}
          onChange={(e) => set({ maxFavoritesPerUser: e.target.value === "" ? null : Number(e.target.value) })}
        />
        <p className="text-xs text-muted-foreground">{t("adminOps.settings.maxFavoritesHint")}</p>
      </div>
      <div className="grid max-w-xs gap-2">
        <Label htmlFor="max-watched">{t("adminOps.settings.maxWatched")}</Label>
        <Input
          id="max-watched"
          type="number"
          min={1}
          max={100000}
          value={value.maxWatchedAddresses}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isInteger(next) && next >= 1) set({ maxWatchedAddresses: next });
          }}
        />
        <p className="max-w-prose text-xs text-muted-foreground">{t("adminOps.settings.maxWatchedHint")}</p>
      </div>
      <div className="flex flex-col gap-3 rounded-xl bg-raised/50 p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t("adminOps.maintenance.title")}</h3>
          {original.maintenance.enabled ? <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">{t("adminOps.maintenance.active")}</span> : null}
        </div>
        <Toggle
          label={t("adminOps.maintenance.toggle")}
          hint={t("adminOps.maintenance.hint")}
          checked={value.maintenance.enabled}
          onChange={(enabled) => setMaintenance({ enabled })}
        />
        <div className="grid gap-3 md:grid-cols-2">
          {(["zh-TW", "en"] as const).map((l) => (
            <div key={l} className="grid gap-2">
              <Label htmlFor={`maintenance-${l}`}>{t(l === "zh-TW" ? "adminOps.maintenance.messageZh" : "adminOps.maintenance.messageEn")}</Label>
              <Textarea
                id={`maintenance-${l}`}
                rows={2}
                maxLength={280}
                value={value.maintenance.message[l]}
                onChange={(e) => setMaintenance({ message: { ...value.maintenance.message, [l]: e.target.value } })}
                className="font-sans text-sm"
              />
            </div>
          ))}
        </div>
        <div className="grid gap-2 md:max-w-xs">
          <Label htmlFor="maintenance-ends">{t("adminOps.maintenance.endsAt")}</Label>
          <Input
            id="maintenance-ends"
            type="datetime-local"
            value={toLocalInput(value.maintenance.endsAt)}
            onChange={(e) => setMaintenance({ endsAt: fromLocalInput(e.target.value) })}
          />
          <span className="text-xs text-muted-foreground">{t("adminOps.maintenance.endsAtHint")}</span>
        </div>
      </div>
    </FormCard>
  );
}

function DiscoveryForm({ value: incoming, revision: incomingRevision }: { value: AdminSettings["discovery"]; revision: string }) {
  const { t } = useI18n();
  const { value, original, revision, setValue, accept } = useSectionDraft<"discovery">(incoming, incomingRevision);
  const [marketsInput, setMarketsInput] = useState({ revision, text: original.homeMarkets.join(", ") });
  if (marketsInput.revision !== revision) setMarketsInput({ revision, text: original.homeMarkets.join(", ") });
  const marketsText = marketsInput.text;
  const setMarketsText = (text: string) => setMarketsInput({ revision, text });
  const [boardsInput, setBoardsInput] = useState({ revision, cryptoBoards: original.cryptoBoards.join(", "), stockBoards: original.stockBoards.join(", ") });
  if (boardsInput.revision !== revision) setBoardsInput({ revision, cryptoBoards: original.cryptoBoards.join(", "), stockBoards: original.stockBoards.join(", ") });
  const [candidate, setCandidate] = useState("");
  const [candidateError, setCandidateError] = useState<string>();
  const set = (patch: Partial<AdminSettings["discovery"]>) => setValue((v) => ({ ...v, ...patch }));
  const featured = value.featuredAddresses;

  function addFeatured() {
    const address = candidate.trim().toLowerCase();
    if (!addressSchema.safeParse(address).success) {
      setCandidateError(t("admin.settings.discovery.featuredInvalid"));
      return;
    }
    if (featured.includes(address)) {
      setCandidateError(t("admin.settings.discovery.featuredDuplicate"));
      return;
    }
    if (featured.length >= MAX_FEATURED) {
      setCandidateError(t("admin.settings.discovery.featuredFull", { max: MAX_FEATURED }));
      return;
    }
    set({ featuredAddresses: [...featured, address] });
    setCandidate("");
    setCandidateError(undefined);
  }

  function move(index: number, delta: number) {
    const next = [...featured];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    set({ featuredAddresses: next });
  }

  return (
    <FormCard id="discovery" title={t("admin.settings.discovery.title")} section="discovery" value={value} original={original} revision={revision} onSaved={accept}>
      <div className="grid gap-2">
        <Label>{t("admin.settings.discovery.featured")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("admin.settings.discovery.featuredHint", { max: MAX_FEATURED })}
        </p>
        {featured.length > 0 ? (
          <ol className="flex flex-col gap-1.5">
            {featured.map((address, i) => (
              <li key={address} className="flex items-center gap-2.5 rounded-xl bg-raised/60 py-1.5 pr-1.5 pl-3">
                <span className="num w-5 text-xs text-subtle-foreground">{i + 1}</span>
                <AddressAvatar seed={address} size={22} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{address}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={t("admin.settings.discovery.moveUp")}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={i === featured.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={t("admin.settings.discovery.moveDown")}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => set({ featuredAddresses: featured.filter((a) => a !== address) })}
                  aria-label={t("admin.settings.discovery.remove")}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex gap-2">
          <Input
            value={candidate}
            onChange={(e) => {
              setCandidate(e.target.value);
              setCandidateError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addFeatured();
              }
            }}
            placeholder={t("admin.settings.discovery.featuredPlaceholder")}
            aria-invalid={candidateError ? true : undefined}
            aria-label={t("admin.settings.discovery.featuredPlaceholder")}
            className="font-mono"
            disabled={featured.length >= MAX_FEATURED}
          />
          <Button type="button" variant="secondary" className="h-10" onClick={addFeatured} disabled={featured.length >= MAX_FEATURED}>
            <Plus />
            {t("admin.settings.discovery.featuredAdd")}
          </Button>
        </div>
        {candidateError ? <p className="text-xs text-negative">{candidateError}</p> : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="home-markets">{t("admin.settings.discovery.homeMarkets")}</Label>
        <Input
          id="home-markets"
          value={marketsText}
          onChange={(e) => {
            setMarketsText(e.target.value);
            set({
              homeMarkets: e.target.value
                .split(",")
                .map((m) => m.trim())
                .filter(Boolean),
            });
          }}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">{t("admin.settings.discovery.homeMarketsHint")}</p>
      </div>

      <Toggle
        label={t("admin.settings.discovery.hideVaults")}
        checked={value.hideVaults}
        onChange={(hideVaults) => set({ hideVaults })}
      />

      <div className="grid gap-2">
        <Label>{t("admin.settings.discovery.defaultActiveWithin")}</Label>
        <Segmented
          variant="pill"
          size="md"
          label={t("admin.settings.discovery.defaultActiveWithin")}
          value={value.defaultActiveWithin}
          onChange={(defaultActiveWithin) => set({ defaultActiveWithin })}
          options={activeWithinSchema.options.map((a) => ({
            value: a,
            label: t(`admin.settings.discovery.activeOptions.${a}`),
          }))}
          className="flex-wrap justify-self-start rounded-2xl sm:rounded-full"
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("admin.settings.discovery.defaultActiveWithinHint")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2"><Label htmlFor="candidate-pool-size">{t("settingsOps.candidatePoolSize")}</Label>
          <Input id="candidate-pool-size" type="number" min={50} max={5000} value={value.candidatePoolSize} onChange={e => set({ candidatePoolSize: Number(e.target.value) })} /></div>
        <div className="grid gap-2"><Label htmlFor="pool-weight">{t("settingsOps.poolWeightPerMinute")}</Label>
          <Input id="pool-weight" type="number" min={0} max={600} value={value.poolWeightPerMinute} onChange={e => set({ poolWeightPerMinute: Number(e.target.value) })} /></div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("settingsOps.poolHint")}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        {([["poolPerformanceWeightPerMinute", "performanceWeight"], ["historyWeightPerMinute", "historyWeight"], ["backfillWeightPerMinute", "backfillWeight"]] as const).map(([field, label]) => (
          <div key={field} className="grid content-start gap-2">
            <Label htmlFor={field}>{t(`adminOps.settings.${label}`)}</Label>
            <Input id={field} type="number" min={0} max={600} value={value[field]} onChange={e => set({ [field]: Number(e.target.value) })} />
          </div>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("adminOps.settings.weightsHint")}</p>
      {(["cryptoBoards", "stockBoards"] as const).map(key => <div key={key} className="grid gap-2">
        <Label htmlFor={key}>{t(`settingsOps.${key}`)}</Label>
        <Input id={key} value={boardsInput[key]} onChange={e => { setBoardsInput({ ...boardsInput, [key]: e.target.value }); set({ [key]: [...new Set(e.target.value.split(",").map(v => v.trim()).filter(Boolean))] }); }} />
        <p className="text-xs text-muted-foreground">{t("settingsOps.boardsHint")}</p>
      </div>)}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="low-sample">{t("admin.settings.discovery.lowSample")}</Label>
          <Input
            id="low-sample"
            type="number"
            min={0}
            max={1000}
            value={value.lowSampleThreshold}
            onChange={(e) => set({ lowSampleThreshold: Number(e.target.value) })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="refresh">{t("admin.settings.discovery.refresh")}</Label>
          <Input
            id="refresh"
            type="number"
            min={5}
            max={240}
            value={value.leaderboardRefreshMinutes}
            onChange={(e) => set({ leaderboardRefreshMinutes: Number(e.target.value) })}
          />
        </div>
      </div>
    </FormCard>
  );
}

function NotificationsForm({ value: incoming, revision: incomingRevision }: { value: AdminSettings["notifications"]; revision: string }) {
  const { t } = useI18n();
  const { value, original, revision, setValue, accept } = useSectionDraft<"notifications">(incoming, incomingRevision);
  return (
    <FormCard
      id="notifications"
      title={t("admin.settings.notifications.title")}
      section="notifications"
      value={value}
      original={original}
      revision={revision}
      onSaved={accept}
    >
      <Toggle
        label={t("admin.settings.notifications.alertsEnabled")}
        hint={t("admin.settings.notifications.alertsHint")}
        checked={value.alertsEnabled}
        onChange={(alertsEnabled) => setValue({ ...value, alertsEnabled })}
      />
      <div className="grid max-w-xs gap-2">
        <Label htmlFor="max-alert-traders">{t("admin.settings.notifications.maxAlertTraders")}</Label>
        <Input
          id="max-alert-traders"
          type="number"
          min={1}
          max={1000}
          value={value.maxAlertTraders}
          onChange={(e) => setValue({ ...value, maxAlertTraders: Number(e.target.value) })}
        />
        <p className="text-xs text-muted-foreground">{t("admin.settings.notifications.maxAlertTradersHint")}</p>
      </div>
    </FormCard>
  );
}

function RevenueForm({ value: incoming, revision: incomingRevision }: { value: AdminSettings["revenue"]; revision: string }) {
  const { t, format } = useI18n();
  const { value, original, revision, setValue, accept } = useSectionDraft<"revenue">(incoming, incomingRevision);
  const [feeInput, setFeeInput] = useState({ revision, text: String(original.builderFeeTenthsBps / 1000) });
  if (feeInput.revision !== revision) setFeeInput({ revision, text: String(original.builderFeeTenthsBps / 1000) });
  const feeText = feeInput.text;
  const setFeeText = (text: string) => setFeeInput({ revision, text });
  const set = (patch: Partial<AdminSettings["revenue"]>) => setValue((v) => ({ ...v, ...patch }));

  return (
    <FormCard id="revenue" title={t("admin.settings.revenue.title")} section="revenue" value={value} original={original} revision={revision} onSaved={accept}>
      <div className="grid gap-2">
        <Label htmlFor="builder-address">{t("admin.settings.revenue.address")}</Label>
        <Input
          id="builder-address"
          value={value.builderAddress ?? ""}
          onChange={(e) => set({ builderAddress: e.target.value.trim() ? e.target.value.trim().toLowerCase() : null })}
          placeholder="0x…"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">{t("admin.settings.revenue.addressHint")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="builder-fee">{t("admin.settings.revenue.fee")}</Label>
          <Input
            id="builder-fee"
            inputMode="decimal"
            value={feeText}
            onChange={(e) => {
              setFeeText(e.target.value);
              const pct = Number(e.target.value);
              set({ builderFeeTenthsBps: Number.isFinite(pct) ? Math.round(pct * 1000) : Number.NaN });
            }}
          />
          <p className="num text-xs text-muted-foreground">
            {t("admin.settings.revenue.feeHint", {
              tenths: Number.isFinite(value.builderFeeTenthsBps) ? format.num(value.builderFeeTenthsBps, 0) : "—",
            })}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="referral-code">{t("admin.settings.revenue.referralCode")}</Label>
          <Input
            id="referral-code"
            value={value.referralCode ?? ""}
            onChange={(e) => set({ referralCode: e.target.value.trim() || null })}
            className="font-mono"
          />
        </div>
      </div>
    </FormCard>
  );
}
