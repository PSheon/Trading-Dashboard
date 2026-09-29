"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addressSchema,
  discoverySettingsSchema,
  generalSettingsSchema,
  notificationSettingsSchema,
  revenueSettingsSchema,
  type AdminSettings,
  type PatchAdminSettingsRequest,
} from "@trading-dashboard/shared";
import { ArrowDown, ArrowUp, Check, Plus, X } from "lucide-react";
import { useState } from "react";
import type { ZodTypeAny } from "zod";
import { cn } from "cn";

import { ErrorState, Panel, Skeleton } from "@/components/page";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const settings = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => api.get<AdminSettings>("/admin/settings"),
    refetchInterval: false,
  });

  if (settings.isError) {
    return (
      <Panel>
        <ErrorState message={settings.error.message} onRetry={() => settings.refetch()} />
      </Panel>
    );
  }
  if (!settings.data) return <Skeleton className="h-[480px] rounded-2xl" />;

  // Keyed by content so a successful save resets each form to the server copy.
  const d = settings.data;
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <GeneralForm key={JSON.stringify(d.general)} value={d.general} />
      <DiscoveryForm key={JSON.stringify(d.discovery)} value={d.discovery} />
      <NotificationsForm key={JSON.stringify(d.notifications)} value={d.notifications} />
      <RevenueForm key={JSON.stringify(d.revenue)} value={d.revenue} />
    </div>
  );
}

function useSaveSection<S extends Section>(section: S) {
  const queryClient = useQueryClient();
  return useMutation<AdminSettings, ApiError, AdminSettings[S]>({
    mutationFn: (value) =>
      api.patch<AdminSettings>("/admin/settings", { [section]: value } as PatchAdminSettingsRequest),
    onSuccess: (data) => {
      queryClient.setQueryData(["admin", "settings"], data);
      void queryClient.invalidateQueries({ queryKey: ["site-settings"] });
    },
  });
}

function FormCard<S extends Section>({
  id,
  title,
  section,
  value,
  original,
  children,
}: {
  id: string;
  title: string;
  section: S;
  value: AdminSettings[S];
  original: AdminSettings[S];
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const save = useSaveSection(section);
  const [clientError, setClientError] = useState<string>();
  const dirty = JSON.stringify(value) !== JSON.stringify(original);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = SCHEMAS[section].safeParse(value);
    if (!parsed.success) {
      setClientError(
        parsed.error.issues.map((i) => `${i.path.join(".") || section}: ${i.message}`).join("; "),
      );
      return;
    }
    setClientError(undefined);
    save.mutate(parsed.data as AdminSettings[S]);
  }

  return (
    <Panel id={id} className="scroll-mt-24 p-5 md:p-6">
      <form onSubmit={submit} className="flex flex-col gap-5">
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
        {children}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
          {clientError || save.isError ? (
            <p role="alert" className="mr-auto text-xs text-negative">
              {t("admin.settings.failed", { message: clientError ?? save.error?.message ?? "" })}
            </p>
          ) : dirty ? (
            <p className="mr-auto text-xs text-warning">{t("admin.settings.unsaved")}</p>
          ) : save.isSuccess ? (
            <p className="mr-auto flex items-center gap-1 text-xs text-positive">
              <Check className="size-3.5" />
              {t("admin.settings.saved")}
            </p>
          ) : null}
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? t("common.saving") : t("admin.settings.saveSection")}
          </Button>
        </div>
      </form>
    </Panel>
  );
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

function GeneralForm({ value: original }: { value: AdminSettings["general"] }) {
  const { t } = useI18n();
  const [value, setValue] = useState(original);
  const set = (patch: Partial<AdminSettings["general"]>) => setValue((v) => ({ ...v, ...patch }));
  const setAnnouncement = (patch: Partial<AdminSettings["general"]["announcement"]>) =>
    set({ announcement: { ...value.announcement, ...patch } });

  return (
    <FormCard id="general" title={t("admin.settings.general.title")} section="general" value={value} original={original}>
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
    </FormCard>
  );
}

function DiscoveryForm({ value: original }: { value: AdminSettings["discovery"] }) {
  const { t } = useI18n();
  const [value, setValue] = useState(original);
  const [marketsText, setMarketsText] = useState(original.homeMarkets.join(", "));
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
    <FormCard id="discovery" title={t("admin.settings.discovery.title")} section="discovery" value={value} original={original}>
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

function NotificationsForm({ value: original }: { value: AdminSettings["notifications"] }) {
  const { t } = useI18n();
  const [value, setValue] = useState(original);
  return (
    <FormCard
      id="notifications"
      title={t("admin.settings.notifications.title")}
      section="notifications"
      value={value}
      original={original}
    >
      <Toggle
        label={t("admin.settings.notifications.alertsEnabled")}
        hint={t("admin.settings.notifications.alertsHint")}
        checked={value.alertsEnabled}
        onChange={(alertsEnabled) => setValue({ ...value, alertsEnabled })}
      />
    </FormCard>
  );
}

function RevenueForm({ value: original }: { value: AdminSettings["revenue"] }) {
  const { t, format } = useI18n();
  const [value, setValue] = useState(original);
  const [feeText, setFeeText] = useState(String(original.builderFeeTenthsBps / 1000));
  const set = (patch: Partial<AdminSettings["revenue"]>) => setValue((v) => ({ ...v, ...patch }));

  return (
    <FormCard id="revenue" title={t("admin.settings.revenue.title")} section="revenue" value={value} original={original}>
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
