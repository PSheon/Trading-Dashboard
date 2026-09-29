"use client";

import type { PnlTier, TraderActivity, TraderActivityResponse, TraderAnalyticsResponse, TraderProfileResponse } from "@/lib/contracts";
import { Check, Copy, Radio, Share2 } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { AlertBell } from "@/components/alerts/alert-bell";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { TraderName } from "@/components/traders/trader-name";
import { ACTIVITY_DOT, FavoriteButton, LowSampleTag, VaultBadge } from "@/components/traders/bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/i18n/provider";
import { coinLabel, truncateAddress } from "@/lib/format";
import type { LiveStatus } from "@/lib/use-live-trader";
import { useNow } from "@/lib/use-now";
import { ComputingState, CoverageNote } from "./trade-analytics";

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

/** A part of the account value, under the total. */
function SubRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span aria-hidden className="h-px w-2.5 bg-border-strong" />
        {label}
      </span>
      <span className="num font-medium" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

/** Green "Live" while the page streams from Hyperliquid's WebSocket; grey
 * while it falls back to polling the api. */
function LiveBadge({ status }: { status: LiveStatus }) {
  const { t } = useI18n();
  const live = status === "live";
  return (
    <span
      role="status"
      data-live={status}
      title={t(live ? "trader.liveHint" : "trader.pollingHint")}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[0.6875rem] font-semibold",
        live ? "bg-positive-soft text-positive" : "bg-raised text-subtle-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          live ? "animate-pulse bg-positive" : "bg-subtle-foreground",
          status === "connecting" && "animate-pulse",
        )}
      />
      {t(live ? "trader.live" : status === "connecting" ? "trader.connecting" : "trader.polling")}
    </span>
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
  liveStatus,
  allTimeVolume,
  trades,
  tradesComputing,
}: {
  profile: TraderProfileResponse;
  activity: TraderActivityResponse | null | undefined;
  lowSampleThreshold: number;
  liveStatus: LiveStatus;
  /** From the same `portfolio` as the page's PnL (all-time window). */
  allTimeVolume: number | null;
  /** All-time trade analytics (any address), for 分組 and 最佳與最差. */
  trades: TraderAnalyticsResponse | undefined;
  /** The api is still reconstructing a cold address's trades. */
  tradesComputing: boolean;
}) {
  const { t, format } = useI18n();
  const { copied, copy } = useCopied();

  const gross = profile.longNotional + profile.shortNotional;
  // Leverage and margin usage are perp figures: relative to perp equity,
  // not the total (spot and staking don't margin the positions).
  const leverage = profile.perpEquity > 0 ? gross / profile.perpEquity : 0;
  const longShare = gross > 0 ? profile.longNotional / gross : 0.5;
  const bias =
    gross === 0 || Math.abs(longShare - 0.5) < 0.1
      ? t("trader.biasNeutral")
      : longShare > 0.5
        ? t("trader.biasLong")
        : t("trader.biasShort");
  const unrealized = profile.positions.reduce((s, p) => s + p.unrealizedPnl, 0);

  return (
    <aside className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3.5">
        <AddressAvatar seed={profile.address} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h1 className="flex min-w-0 text-[0.9375rem] font-bold">
              <TraderName trader={profile} />
            </h1>
            {profile.isVault ? <VaultBadge /> : null}
          </div>
          <button
            type="button"
            onClick={() => copy("address", profile.address)}
            className="num mt-0.5 flex items-center gap-1 rounded font-mono text-[11px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
        <LiveBadge status={liveStatus} />
      </div>

      <div className="border-t border-border px-4 py-4">
        <p className="text-xs text-muted-foreground" title={profile.isVault ? undefined : t("trader.accountValueHint")}>
          {profile.isVault ? t("common.tvl") : t("trader.accountValue")}
        </p>
        <p className="num mt-1.5 text-[1.625rem] leading-none font-bold tracking-tight" data-testid="account-value">
          {format.usd(profile.accountValue, { digits: 2 })}
        </p>
        <div className="mt-2.5 flex flex-col text-xs">
          <SubRow label={t("trader.accountPerp")} value={format.usd(profile.perpEquity, { digits: 2 })} testId="perp-equity" />
          <SubRow label={t("trader.accountSpot")} value={format.usd(profile.spotValue, { digits: 2 })} testId="spot-value" />
          {profile.stakedValue > 0 ? (
            <SubRow label={t("trader.accountStaked")} value={format.usd(profile.stakedValue, { digits: 2 })} />
          ) : null}
        </div>
        {profile.accountMode !== "standard" ? (
          <p className="mt-2 text-[11px] leading-relaxed text-subtle-foreground">
            {t(profile.accountMode === "unified" ? "trader.accountUnified" : "trader.accountPortfolioMargin")}
          </p>
        ) : null}
      </div>

      <Section title={t("trader.holdings")}>
        <div className="flex items-center justify-between text-[0.8125rem]">
          <span className="text-muted-foreground">
            {t("trader.leverage")}{" "}
            <span className="text-[11px] text-subtle-foreground">({t("trader.perpBasis")})</span>
          </span>
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
        <Row label={`${t("trader.marginUsage")} (${t("trader.perpBasis")})`}>
          {format.pct(profile.perpEquity > 0 ? profile.marginUsed / profile.perpEquity : 0)}
        </Row>
        <Row label={t("trader.volume")}>
          {allTimeVolume === null ? "—" : format.usd(allTimeVolume, { compact: true })}
        </Row>
        <Row label={t("trader.withdrawable")}>{format.usd(profile.withdrawable, { compact: true })}</Row>
        <Row label={t("trader.openPositions")}>{profile.positions.length}</Row>
      </Section>

      <GroupsSection trades={trades} computing={tradesComputing} />
      <BestWorstSection trades={trades} computing={tradesComputing} />
      <MostTradedSection trades={trades} computing={tradesComputing} />
    </aside>
  );
}

const PNL_TONE: Record<PnlTier, string> = {
  extremely_profitable: "text-primary",
  very_profitable: "text-positive",
  profitable: "text-positive",
  break_even: "",
  unprofitable: "text-negative",
  very_unprofitable: "text-negative",
  rekt: "text-negative",
};

/** Placeholder rows while the api computes a cold address. */
function PendingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 py-1" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex justify-between">
          <span className="h-3.5 w-20 animate-pulse rounded bg-raised" />
          <span className="h-3.5 w-14 animate-pulse rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}

/** 分組: CopyDog's trading style, PnL cohort and size cohort. */
function GroupsSection({ trades, computing }: { trades: TraderAnalyticsResponse | undefined; computing: boolean }) {
  const { t } = useI18n();
  const c = trades?.classification;
  return (
    <Section title={t("trader.groups")}>
      {!trades && computing ? (
        <>
          <PendingRows />
          <ComputingState compact />
        </>
      ) : (
        <>
          <Row label={t("trader.tradingStyle")}>
            <span title={c?.style ? t(`trader.styleHints.${c.style}`) : undefined} data-testid="trading-style">
              {c?.style ? t(`trader.styles.${c.style}`) : "—"}
            </span>
          </Row>
          <Row label={t("trader.pnlTier")}>
            <span
              className={c?.pnlTier ? PNL_TONE[c.pnlTier] : ""}
              title={c?.pnlTier ? t(`trader.pnlTierHints.${c.pnlTier}`) : undefined}
              data-testid="pnl-tier"
            >
              {c?.pnlTier ? t(`trader.pnlTiers.${c.pnlTier}`) : "—"}
            </span>
          </Row>
          <Row label={t("trader.sizeTier")}>
            <span title={c?.sizeTier ? t(`trader.sizeTierHints.${c.sizeTier}`) : undefined} data-testid="size-tier">
              {c?.sizeTier ? t(`trader.sizeTiers.${c.sizeTier}`) : "—"}
            </span>
          </Row>
        </>
      )}
    </Section>
  );
}

/** 最佳與最差: the three best or worst closed trades by net PnL. */
function BestWorstSection({ trades, computing }: { trades: TraderAnalyticsResponse | undefined; computing: boolean }) {
  const { t, format } = useI18n();
  const [view, setView] = useState<"best" | "worst">("best");
  const rows = (view === "best" ? trades?.summary.best : trades?.summary.worst)?.slice(0, 3) ?? [];
  return (
    <Section
      title={t("trader.bestWorst")}
      action={
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "best", label: t("trader.best") },
            { value: "worst", label: t("trader.worst") },
          ]}
          label={t("trader.bestWorst")}
        />
      }
    >
      {!trades && computing ? (
        <PendingRows />
      ) : rows.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {rows.map((trade) => (
            <li key={trade.id} className="flex items-center justify-between py-1 text-[0.8125rem]">
              <span className="flex items-center gap-2 font-medium">
                <CoinIcon coin={trade.coin} size={18} />
                {coinLabel(trade.coin)}
              </span>
              <span className={cn("num font-semibold", trade.netPnl >= 0 ? "text-positive" : "text-negative")}>
                {format.usd(trade.netPnl, { sign: true, compact: true })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("trader.noClosedTrades")}</p>
      )}
    </Section>
  );
}

/** 最常交易: the three coins with the most volume (Σ size × entry). */
function MostTradedSection({ trades, computing }: { trades: TraderAnalyticsResponse | undefined; computing: boolean }) {
  const { t, format } = useI18n();
  const rows = [...(trades?.summary.coins ?? [])].sort((a, b) => b.volume - a.volume).slice(0, 3);
  return (
    <Section title={t("trader.mostTraded")}>
      {!trades && computing ? (
        <PendingRows />
      ) : rows.length > 0 ? (
        <>
          <ul className="flex flex-col gap-1">
            {rows.map((coin) => (
              <li key={coin.coin} className="flex items-center justify-between py-1 text-[0.8125rem]">
                <span className="flex items-center gap-2 font-medium">
                  <CoinIcon coin={coin.coin} size={18} />
                  {coinLabel(coin.coin)}
                </span>
                <span className="num font-semibold">{format.usd(coin.volume, { compact: true })}</span>
              </li>
            ))}
          </ul>
          {trades ? <CoverageNote analytics={trades} className="mt-2" /> : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t("trader.noClosedTrades")}</p>
      )}
    </Section>
  );
}
