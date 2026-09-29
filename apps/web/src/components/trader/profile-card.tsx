"use client";

import type { TraderActivity, TraderActivityResponse, TraderProfileResponse } from "@/lib/contracts";
import { Check, ChevronDown, Copy, Radio, Share2 } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { AlertBell } from "@/components/alerts/alert-bell";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { ACTIVITY_DOT, FavoriteButton, LowSampleTag, VaultBadge } from "@/components/traders/bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/i18n/provider";
import { coinLabel, traderName, truncateAddress } from "@/lib/format";
import { useNow } from "@/lib/use-now";

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  return {
    copied,
    copy(key: string, text: string) {
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(key);
        setTimeout(() => setCopied(null), 1400);
      });
    },
  };
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="border-t border-border px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-[0.8125rem]">
      <span className="text-muted-foreground">{label}</span>
      <span className="num text-right font-medium">{children}</span>
    </div>
  );
}

function Meter({ fill, className }: { fill: number; className?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div
        className={cn("h-full rounded-full bg-primary", className)}
        style={{ width: `${Math.max(2, Math.min(100, fill * 100))}%` }}
      />
    </div>
  );
}

const HOUR_MS = 3_600_000;

/** How recent a timestamp is, in the same buckets as the list badges. */
function activityAt(at: Date | string | null, now: number): TraderActivity {
  if (at === null) return "inactive";
  const age = now - new Date(at).getTime();
  if (age < 24 * HOUR_MS) return "day";
  if (age < 7 * 24 * HOUR_MS) return "week";
  if (age < 30 * 24 * HOUR_MS) return "month";
  return "inactive";
}

/** "最後交易 3 小時前" (Stage 2 §12): the latest perp fill, relative, in
 * the locale's Intl.RelativeTimeFormat; exact time on hover. */
function LastTrade({ at }: { at: Date | string | null }) {
  const { t, format } = useI18n();
  const now = useNow();
  const bucket = activityAt(at, now);
  return (
    <span
      title={at === null ? undefined : t("trader.lastTradeHint", { time: format.dateTime(at) })}
      className={cn(
        "num inline-flex h-6 items-center gap-1.5 rounded-full bg-raised px-2 text-[0.6875rem] font-semibold",
        bucket === "inactive" ? "text-subtle-foreground" : "text-muted-foreground",
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ACTIVITY_DOT[bucket])} />
      {at === null ? t("trader.noTrades") : t("trader.lastTrade", { time: format.relative(at, now) })}
    </span>
  );
}

/** Placeholder for the last-trade pill while the activity request runs. */
function LastTradeLoading() {
  const { t } = useI18n();
  return (
    <span className="inline-flex h-6 w-28 animate-pulse items-center rounded-full bg-raised" role="status">
      <span className="sr-only">{t("trader.activityLoading")}</span>
    </span>
  );
}

/** Left column: identity, last trade, account value, leverage, bias,
 * overview, our own analytics, best / worst coins. `activity` (last trade,
 * sample size) arrives after the profile: undefined while loading (its pill
 * pulses), null if it failed (no pill). */
export function ProfileCard({
  profile,
  activity,
  lowSampleThreshold,
}: {
  profile: TraderProfileResponse;
  activity: TraderActivityResponse | null | undefined;
  lowSampleThreshold: number;
}) {
  const { t, format } = useI18n();
  const { copied, copy } = useCopied();
  const [coinsView, setCoinsView] = useState<"best" | "worst">("best");

  const gross = profile.longNotional + profile.shortNotional;
  const leverage = profile.accountValue > 0 ? gross / profile.accountValue : 0;
  const longShare = gross > 0 ? profile.longNotional / gross : 0.5;
  const bias =
    gross === 0 || Math.abs(longShare - 0.5) < 0.1
      ? t("trader.biasNeutral")
      : longShare > 0.5
        ? t("trader.biasLong")
        : t("trader.biasShort");
  const unrealized = profile.positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const coins = coinsView === "best" ? profile.analytics?.bestCoins : profile.analytics?.worstCoins;

  return (
    <aside className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3.5">
        <AddressAvatar seed={profile.address} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h1 className="truncate text-[0.9375rem] font-bold">{traderName(profile)}</h1>
            {profile.isVault ? <VaultBadge /> : null}
          </div>
          <button
            type="button"
            onClick={() => copy("address", profile.address)}
            className="mt-0.5 flex items-center gap-1 rounded font-mono text-[11px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            title={profile.address}
            aria-label={`${t("common.copy")} ${profile.address}`}
          >
            {truncateAddress(profile.address)}
            {copied === "address" ? <Check className="size-3 text-positive" /> : <Copy className="size-3" />}
          </button>
        </div>
        <FavoriteButton address={profile.address} favorite={profile.favorite} size="sm" />
        <AlertBell address={profile.address} className="-ml-1.5" />
        <button
          type="button"
          onClick={() => copy("link", window.location.href)}
          aria-label={copied === "link" ? t("common.linkCopied") : t("common.share")}
          title={copied === "link" ? t("common.linkCopied") : t("common.share")}
          className="-ml-1.5 inline-flex size-7 items-center justify-center rounded-full text-subtle-foreground outline-none hover:bg-raised-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied === "link" ? <Check className="size-4 text-positive" /> : <Share2 className="size-4" />}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3.5">
        {activity ? (
          <LastTrade at={activity.lastTradeAt} />
        ) : activity === undefined ? (
          <LastTradeLoading />
        ) : null}
        {profile.tracked ? (
          <span className="inline-flex h-6 items-center gap-1 rounded-full bg-primary-soft px-2 text-[0.6875rem] font-semibold text-primary">
            <Radio className="size-3" />
            {t("trader.tracked")}
          </span>
        ) : null}
        {activity?.sample.lowSample ? (
          <LowSampleTag
            fills={activity.sample.fills30d}
            capped={activity.sample.capped}
            threshold={lowSampleThreshold}
          />
        ) : null}
      </div>

      <div className="border-t border-border px-4 py-4">
        <p className="text-xs text-muted-foreground">{profile.isVault ? t("common.tvl") : t("trader.accountValue")}</p>
        <p className="num mt-1.5 text-[1.625rem] leading-none font-bold tracking-tight">
          {format.usd(profile.accountValue, { digits: 2 })}
        </p>
      </div>

      <Section title={t("trader.holdings")}>
        <div className="flex items-center justify-between text-[0.8125rem]">
          <span className="text-muted-foreground">{t("trader.leverage")}</span>
          <span className="num font-semibold text-primary">{format.num(leverage, 2)}×</span>
        </div>
        <div className="mt-2">
          <Meter fill={leverage / 10} />
        </div>
        <p className="num mt-1.5 text-[11px] text-subtle-foreground">
          {t("trader.notional", { value: format.usd(gross, { compact: true }) })}
        </p>

        <div className="mt-4 flex items-center justify-between text-[0.8125rem]">
          <span className="text-muted-foreground">{t("trader.bias")}</span>
          <span className="font-semibold">{bias}</span>
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-border">
          {gross > 0 ? (
            <>
              <div className="h-full bg-positive" style={{ width: `${longShare * 100}%` }} />
              <div className="h-full bg-negative" style={{ width: `${(1 - longShare) * 100}%` }} />
            </>
          ) : null}
        </div>
        <div className="num mt-1.5 flex justify-between text-[11px]">
          <span>
            <span className="text-positive">{format.pct(gross > 0 ? longShare : 0)}</span>
            <span className="text-subtle-foreground">
              {" · "}
              {t("common.long")} {format.usd(profile.longNotional, { compact: true })}
            </span>
          </span>
          <span>
            <span className="text-subtle-foreground">
              {format.usd(profile.shortNotional, { compact: true })} {t("common.short")}
              {" · "}
            </span>
            <span className="text-negative">{format.pct(gross > 0 ? 1 - longShare : 0)}</span>
          </span>
        </div>
      </Section>

      <Section title={t("trader.overview")}>
        <Row label={t("trader.unrealized")}>
          <span className={unrealized > 0 ? "text-positive" : unrealized < 0 ? "text-negative" : ""}>
            {format.usd(unrealized, { sign: true, compact: Math.abs(unrealized) >= 1e6 })}
          </span>
        </Row>
        <Row label={t("trader.marginUsage")}>
          {format.pct(profile.accountValue > 0 ? profile.marginUsed / profile.accountValue : 0)}
        </Row>
        <Row label={t("trader.volume")}>
          {profile.stats ? format.usd(profile.stats.volume.allTime, { compact: true }) : "—"}
        </Row>
        <Row label={t("trader.withdrawable")}>{format.usd(profile.withdrawable, { compact: true })}</Row>
        <Row label={t("trader.openPositions")}>{profile.positions.length}</Row>
      </Section>

      <Section title={t("trader.analytics")}>
        {profile.analytics ? (
          <>
            <Row label={t("trader.winRate")}>{format.pct(profile.analytics.winRate30d)}</Row>
            <Row label={t("trader.roundTrips")}>{profile.analytics.roundTrips30d}</Row>
            <Row label={t("trader.realized")}>
              <span className={profile.analytics.realizedPnl30d >= 0 ? "text-positive" : "text-negative"}>
                {format.usd(profile.analytics.realizedPnl30d, { sign: true, compact: true })}
              </span>
            </Row>
            <Row label={t("trader.avgHold")}>{format.duration(profile.analytics.avgHoldSeconds)}</Row>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">{t("trader.notTracked")}</p>
        )}
      </Section>

      <Section
        title={t("trader.bestWorst")}
        action={
          profile.analytics ? (
            <Segmented
              value={coinsView}
              onChange={setCoinsView}
              options={[
                { value: "best", label: t("trader.best") },
                { value: "worst", label: t("trader.worst") },
              ]}
              label={t("trader.bestWorst")}
            />
          ) : (
            <ChevronDown className="size-4 text-subtle-foreground" aria-hidden />
          )
        }
      >
        {coins && coins.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {coins.map((c) => (
              <li key={c.coin} className="flex items-center justify-between py-1 text-[0.8125rem]">
                <span className="flex items-center gap-2 font-medium">
                  <CoinIcon coin={c.coin} size={18} />
                  {coinLabel(c.coin)}
                </span>
                <span className={cn("num font-semibold", c.pnl >= 0 ? "text-positive" : "text-negative")}>
                  {format.usd(c.pnl, { sign: true, compact: true })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t("trader.noCoins")}</p>
        )}
      </Section>
    </aside>
  );
}
