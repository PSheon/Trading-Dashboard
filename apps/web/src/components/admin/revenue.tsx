"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AdminRevenueResponse } from "@/lib/contracts";
import { Coins, Settings, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EmptyState, ErrorState, Panel, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/i18n/provider";
import { api } from "@/lib/api";
import { truncateAddress } from "@/lib/format";

type Range = "7d" | "30d" | "90d" | "all";
const RANGES: Range[] = ["7d", "30d", "90d", "all"];

function Stat({ label, value, tone }: { label: string; value: string; tone?: "builder" | "referral" }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-raised/60 px-4 py-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {tone ? (
          <span
            className="size-2 rounded-full"
            style={{ background: tone === "builder" ? "var(--chart-builder)" : "var(--chart-referral)" }}
          />
        ) : null}
        {label}
      </span>
      <span className="num text-lg font-bold">{value}</span>
    </div>
  );
}

export function AdminRevenue() {
  const { t, format } = useI18n();
  const [range, setRange] = useState<Range>("30d");
  const revenue = useQuery({
    queryKey: ["admin", "revenue", range],
    queryFn: () => api.get<AdminRevenueResponse>(`/admin/revenue?range=${range}`),
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });

  if (revenue.isError) {
    return (
      <Panel>
        <ErrorState message={revenue.error.message} onRetry={() => revenue.refetch()} />
      </Panel>
    );
  }
  const d = revenue.data;
  if (!d) return <Skeleton className="h-96 rounded-2xl" />;

  if (!d.address) {
    return (
      <Panel>
        <EmptyState
          icon={Wallet}
          title={t("admin.revenue.noAddressTitle")}
          body={t("admin.revenue.noAddressBody")}
          action={
            <Button asChild>
              <Link href="/admin/settings#revenue">
                <Settings />
                {t("admin.revenue.goSettings")}
              </Link>
            </Button>
          }
        />
      </Panel>
    );
  }

  const usd = (v: number) => format.usd(v, { digits: 2 });
  // Tenths of a basis point → ratio: 1 bp = 0.0001, so a tenth = 0.00001.
  const feePct = d.builderFeeTenthsBps / 100_000;

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4 text-[0.8125rem]">
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("admin.revenue.address")}</span>
          <span className="font-mono" title={d.address}>
            {truncateAddress(d.address, 8, 6)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("admin.revenue.builderFee")}</span>
          <span className="num font-semibold">{format.pct(feePct, { digits: 3 })}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("admin.revenue.referralCode")}</span>
          <span className="font-mono font-semibold">{d.referralCode ?? "—"}</span>
        </span>
        {d.lastSnapshotAt ? (
          <span className="num ml-auto text-xs text-subtle-foreground">
            {t("admin.revenue.lastSnapshot", { time: format.relative(d.lastSnapshotAt) })}
          </span>
        ) : null}
      </Panel>

      <Panel className="p-5">
        <h3 className="mb-3 text-sm font-semibold">{t("admin.revenue.totalsTitle")}</h3>
        <div className="grid gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label={t("admin.revenue.builder")} value={usd(d.totals.builderUsd)} tone="builder" />
          <Stat label={t("admin.revenue.referral")} value={usd(d.totals.referralUsd)} tone="referral" />
          <Stat label={t("admin.revenue.claimed")} value={usd(d.totals.claimedUsd)} />
          <Stat label={t("admin.revenue.unclaimed")} value={usd(d.totals.unclaimedUsd)} />
          <Stat label={t("admin.revenue.referredUsers")} value={format.num(d.totals.referredUsers, 0)} />
          <Stat
            label={t("admin.revenue.referredVolume")}
            value={format.usd(d.totals.referredVolumeUsd, { compact: true })}
          />
        </div>
      </Panel>

      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{t("admin.revenue.daily")}</h3>
            <p className="num mt-1 text-xs text-muted-foreground">
              {t("admin.revenue.rangeTotal")}{" "}
              <span className="font-semibold text-foreground">{usd(d.rangeUsd.builder + d.rangeUsd.referral)}</span>
              {" · "}
              <span style={{ color: "var(--chart-builder)" }}>{usd(d.rangeUsd.builder)}</span>
              {" + "}
              <span style={{ color: "var(--chart-referral)" }}>{usd(d.rangeUsd.referral)}</span>
            </p>
          </div>
          <Segmented
            variant="pill"
            value={range}
            onChange={setRange}
            options={RANGES.map((r) => ({ value: r, label: t(`admin.revenue.ranges.${r}`) }))}
            label={t("admin.revenue.rangeTitle")}
          />
        </div>
        <div className="mt-5">
          {d.daily.length === 0 ? (
            <EmptyState icon={Coins} title={t("admin.revenue.noData")} />
          ) : (
            <StackedBars daily={d.daily} />
          )}
        </div>
        <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: "var(--chart-builder)" }} />
            {t("admin.revenue.builder")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: "var(--chart-referral)" }} />
            {t("admin.revenue.referral")}
          </span>
        </div>
      </Panel>
    </div>
  );
}

/** Daily stacked bars (builder on the bottom, referral on top), HTML only. */
function StackedBars({ daily }: { daily: AdminRevenueResponse["daily"] }) {
  const { format } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...daily.map((d) => d.builder + d.referral));
  const height = 220;
  const labelEvery = Math.ceil(daily.length / 6);
  const hovered = hover !== null ? daily[hover] : null;

  return (
    <div className="relative">
      <div className="flex items-end gap-[2px]" style={{ height }} onPointerLeave={() => setHover(null)}>
        {daily.map((d, i) => {
          const total = d.builder + d.referral;
          return (
            <div
              key={d.day}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              onPointerEnter={() => setHover(i)}
            >
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity"
                style={{ height: `${(total / max) * 100}%`, opacity: hover === null || hover === i ? 1 : 0.45 }}
              >
                <div style={{ height: `${total ? (d.builder / total) * 100 : 0}%`, background: "var(--chart-builder)" }} />
                <div style={{ height: `${total ? (d.referral / total) * 100 : 0}%`, background: "var(--chart-referral)" }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="num mt-2 flex gap-[2px] text-[10px] text-subtle-foreground">
        {daily.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {i % labelEvery === 0 ? d.day.slice(5).replace("-", "/") : ""}
          </span>
        ))}
      </div>
      {hovered ? (
        <div className="pointer-events-none absolute top-0 right-0 rounded-xl border border-border-strong bg-popover px-3 py-2 text-xs shadow-xl">
          <div className="num font-semibold">{hovered.day}</div>
          <div className="num mt-1" style={{ color: "var(--chart-builder)" }}>
            {format.usd(hovered.builder, { digits: 2 })}
          </div>
          <div className="num" style={{ color: "var(--chart-referral)" }}>
            {format.usd(hovered.referral, { digits: 2 })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
