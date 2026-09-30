"use client";

import type { PnlTier, SizeTier, TraderAnalyticsResponse, TraderProfileResponse } from "@/lib/contracts";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Clock } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/i18n/provider";
import { coinLabel } from "@/lib/format";
import { duration, pnlTone, signedUsd2, signedUsdShort, usd2 } from "@/lib/trade-format";
import { freeSpot, PNL_ICON, SIZE_ICON } from "./profile-card";
import { TradeCard } from "./trade-analytics";

/** CopyDog's leverage bar is full at 30×. */
export const LEVERAGE_BAR_MAX = 30;

export type BiasKey = "veryLong" | "long" | "neutral" | "short" | "veryShort";

/** CopyDog's mobile direction bias from the long share (0–100): ≥ 80 very
 * bullish, ≥ 55 bullish, > 45 neutral, > 20 bearish, else very bearish. */
export function mobileBias(longPct: number): { key: BiasKey; dir: "up" | "right" | "down" } {
  if (longPct >= 80) return { key: "veryLong", dir: "up" };
  if (longPct >= 55) return { key: "long", dir: "up" };
  if (longPct > 45) return { key: "neutral", dir: "right" };
  if (longPct > 20) return { key: "short", dir: "down" };
  return { key: "veryShort", dir: "down" };
}

const BIAS_LABEL = {
  veryLong: "trader.biasVeryLong",
  long: "trader.biasLong",
  neutral: "trader.biasNeutral",
  short: "trader.biasShort",
  veryShort: "trader.biasVeryShort",
} as const satisfies Record<BiasKey, string>;

export interface PieSegment {
  label: string;
  value: number;
  /** The "other" bucket (no coin icon). */
  other?: boolean;
}

/** The donut's segments as CopyDog builds them: positive values, largest
 * first, the first `n` kept and the rest summed into "other". */
export function pieSegments(items: PieSegment[], otherLabel: string, n = 5): PieSegment[] {
  const sorted = items.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, n);
  const rest = sorted.slice(n).reduce((s, x) => s + x.value, 0);
  if (rest > 0) top.push({ label: otherLabel, value: rest, other: true });
  return top;
}

/** The positioning figures CopyDog's 洞察 shows: leverage over the account's
 * equity, margin usage and the distance to liquidation (1 − maintenance ÷
 * perp equity), in percent; `exposed` false without an open position. */
export function positioning(profile: TraderProfileResponse) {
  const long = profile.longNotional ?? 0;
  const short = profile.shortNotional ?? 0;
  const notional = long + short;
  const equity = profile.accountValue ?? 0;
  const perpEquity = profile.perpEquity ?? 0;
  const exposed = profile.positions.length > 0 && notional > 0;
  return {
    exposed,
    notional,
    equity,
    leverage: equity ? notional / equity : 0,
    marginPct: perpEquity ? ((profile.marginUsed ?? 0) / perpEquity) * 100 : 0,
    liqDistancePct:
      perpEquity > 0 && profile.maintenanceMarginUsed != null
        ? Math.max(0, Math.min(100, (1 - profile.maintenanceMarginUsed / perpEquity) * 100))
        : null,
    longPct: notional > 0 ? (long / notional) * 100 : 0,
    shortPct: notional > 0 ? (short / notional) * 100 : 0,
    long,
    short,
  };
}

const PIE_COLORS = ["var(--primary)", "color-mix(in srgb, var(--primary) 55%, var(--card))", "color-mix(in srgb, var(--primary) 28%, var(--card))"];
const pieColor = (i: number) => PIE_COLORS[i] ?? "var(--border-strong)";

function Donut({ segments, icons = false }: { segments: PieSegment[]; icons?: boolean }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  let acc = 0;
  const gradient =
    total > 0
      ? segments
          .map((s, i) => {
            const from = (acc / total) * 360;
            acc += s.value;
            return `${pieColor(i)} ${from}deg ${(acc / total) * 360}deg`;
          })
          .join(", ")
      : "var(--raised) 0deg 360deg";
  return (
    <div className="flex items-center gap-4">
      <div
        aria-hidden
        className="relative size-[72px] shrink-0 rounded-full after:absolute after:inset-[18px] after:rounded-full after:bg-card"
        style={{ background: `conic-gradient(${gradient})` }}
      />
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {segments.map((s, i) => (
          <li key={s.label} className="flex items-center gap-1.5 text-xs">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: pieColor(i) }} />
            {icons && !s.other ? <CoinIcon coin={s.label} size={16} /> : null}
            <span className="min-w-0 truncate text-muted-foreground">{icons && !s.other ? coinLabel(s.label) : s.label}</span>
            <span className="num ml-auto shrink-0 font-semibold">
              {usd2(s.value)}
              <span className="font-normal text-subtle-foreground">{total > 0 ? ` ▪ ${((s.value / total) * 100).toFixed(1)}%` : ""}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5 first:border-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatCard({ label, value, valueClass, children }: { label: string; value: React.ReactNode; valueClass?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("num text-xl font-bold", valueClass)}>{value}</span>
      {children}
    </div>
  );
}

const BAR = { primary: "bg-primary", warning: "bg-warning", danger: "bg-negative" } as const;
function Bar({ pct, tone }: { pct: number; tone: keyof typeof BAR }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div className={cn("h-full rounded-full", BAR[tone])} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

const Sub = ({ children }: { children: React.ReactNode }) => <p className="num text-[11px] text-subtle-foreground">{children}</p>;

const PNL_TONE: Partial<Record<PnlTier, string>> = {
  extremely_profitable: "text-warning",
  very_profitable: "text-positive",
  profitable: "text-positive",
  unprofitable: "text-negative",
  very_unprofitable: "text-negative",
  rekt: "text-negative",
};
const SIZE_TONE: Partial<Record<SizeTier, string>> = { apex: "text-warning" };

/**
 * The phone's 洞察 tab, CopyDog's layout (its app's insights): 總覽 (realized
 * PnL, volume, total trades, average hold, all-time closed trades), 持倉佈局
 * (leverage, margin usage with the distance to liquidation, direction bias,
 * then the account-composition and position-mix donuts), 最佳與最差, 最常交易
 * (by trade count), and 交易者檔案 (style, profitability, account size).
 * A figure without a value is left out, as on CopyDog.
 */
export function MobileInsights({
  profile,
  trades,
  computing,
}: {
  profile: TraderProfileResponse;
  /** All-time trade analytics. */
  trades: TraderAnalyticsResponse | undefined;
  /** The api is still reconstructing a cold address's trades. */
  computing: boolean;
}) {
  const { t } = useI18n();
  const [mix, setMix] = useState<"perp" | "spot">("perp");
  const [view, setView] = useState<"best" | "worst">("best");
  const s = trades?.summary;
  const pos = positioning(profile);
  const bias = mobileBias(pos.longPct);
  const other = t("trader.insightsTab.other");

  const keystats = s
    ? [
        { key: "realized", label: t("trader.insightsTab.realizedPnl"), value: signedUsd2(s.realizedPnl), cls: pnlTone(s.realizedPnl) },
        { key: "volume", label: t("trader.volume"), value: usd2(s.volume) },
        { key: "trades", label: t("trader.insightsTab.totalTrades"), value: String(s.trades) },
        ...(s.avgHoldSeconds != null ? [{ key: "hold", label: t("trader.insightsTab.avgHold"), value: duration(s.avgHoldSeconds) }] : []),
      ]
    : [];

  const composition = pieSegments(
    [
      { label: t("trader.accountPerp"), value: profile.perpEquity ?? 0 },
      { label: t("trader.accountSpot"), value: freeSpot(profile) },
      { label: t("trader.accountStaked"), value: profile.stakedValue ?? 0 },
    ],
    other,
  );
  const perpMix = Object.values(
    profile.positions.reduce<Record<string, PieSegment>>((acc, p) => {
      const v = Math.abs(p.positionValue);
      if (v > 0) acc[p.coin] = { label: p.coin, value: (acc[p.coin]?.value ?? 0) + v };
      return acc;
    }, {}),
  );
  const spotMix = profile.spotBalances.filter((b) => b.value > 0).map((b) => ({ label: b.coin, value: b.value }));
  const mixSegments = pieSegments(mix === "perp" ? perpMix : spotMix, other, 3);

  const best = (s?.best ?? []).filter((x) => x.netPnl > 0).slice(0, 3);
  const worst = (s?.worst ?? []).filter((x) => x.netPnl < 0).slice(0, 3);
  const shown = view === "best" ? best : worst;
  const mostTraded = [...(s?.coins ?? [])].sort((a, b) => b.trades - a.trades).slice(0, 5);
  const c = trades?.classification;
  const profileCells = [
    c?.style ? { key: "style", label: t("trader.tradingStyle"), value: t(`trader.styles.${c.style}`), hint: t(`trader.styleHints.${c.style}`), icon: Clock, cls: "" } : null,
    c?.pnlTier
      ? { key: "pnl", label: t("trader.insightsTab.profitability"), value: t(`trader.pnlTiers.${c.pnlTier}`), hint: t(`trader.pnlTierHints.${c.pnlTier}`), icon: PNL_ICON[c.pnlTier] ?? null, cls: PNL_TONE[c.pnlTier] ?? "" }
      : null,
    c?.sizeTier
      ? { key: "size", label: t("trader.insightsTab.accountSize"), value: t(`trader.sizeTiers.${c.sizeTier}`), hint: t(`trader.sizeTierHints.${c.sizeTier}`), icon: SIZE_ICON[c.sizeTier], cls: SIZE_TONE[c.sizeTier] ?? "" }
      : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  const pending = !trades && computing;
  const BiasIcon = bias.dir === "up" ? ArrowUpRight : bias.dir === "down" ? ArrowDownRight : ArrowRight;

  return (
    <div className="flex flex-col gap-6 px-1" data-testid="mobile-insights">
      {keystats.length > 0 ? (
        <Section title={t("trader.insightsTab.overview")}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            {keystats.map((k) => (
              <div key={k.key} className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{k.label}</dt>
                <dd className={cn("num text-base font-bold", k.cls)}>{k.value}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : pending ? (
        <Section title={t("trader.insightsTab.overview")}>
          <Skeleton className="h-24 rounded-2xl" />
        </Section>
      ) : null}

      <Section title={t("trader.insightsTab.positioning")}>
        <div className="flex flex-col gap-3">
          <StatCard label={t("trader.leverage")} value={pos.exposed ? `${pos.leverage.toFixed(2)}×` : "—"}>
            {pos.exposed ? (
              <>
                <Bar pct={(pos.leverage / LEVERAGE_BAR_MAX) * 100} tone={pos.leverage > 10 ? "danger" : pos.leverage > 5 ? "warning" : "primary"} />
                <Sub>{`${usd2(pos.notional)} ${t("trader.notional")} ▪ ${usd2(pos.equity)} ${t("trader.insightsTab.equity")}`}</Sub>
              </>
            ) : (
              <Sub>{t("trader.insightsTab.noExposure")}</Sub>
            )}
          </StatCard>
          <StatCard
            label={t("trader.marginUsage")}
            value={pos.exposed ? `${pos.marginPct.toFixed(1)}%` : "—"}
            valueClass={pos.exposed ? (pos.marginPct >= 70 ? "text-negative" : pos.marginPct >= 50 ? "text-warning" : "") : ""}
          >
            {pos.exposed ? (
              <>
                <Bar pct={pos.marginPct} tone={pos.marginPct >= 70 ? "danger" : "warning"} />
                {pos.liqDistancePct != null ? (
                  <Sub>{`${pos.liqDistancePct.toFixed(1)}% ${t("trader.insightsTab.fromLiquidation")}`}</Sub>
                ) : null}
              </>
            ) : (
              <Sub>{t("trader.insightsTab.noExposure")}</Sub>
            )}
          </StatCard>
          <StatCard
            label={t("trader.bias")}
            value={
              pos.exposed ? (
                <span className="inline-flex items-center gap-1" data-testid="mobile-bias">
                  {t(BIAS_LABEL[bias.key])}
                  <BiasIcon className="size-4" aria-hidden />
                </span>
              ) : (
                "—"
              )
            }
            valueClass={pos.exposed ? (bias.dir === "up" ? "text-positive" : bias.dir === "down" ? "text-negative" : "") : ""}
          >
            {pos.exposed ? (
              <>
                <div className="flex h-1.5 overflow-hidden rounded-full bg-border">
                  <div className="h-full bg-positive" style={{ width: `${pos.longPct}%` }} />
                  <div className="h-full bg-negative" style={{ width: `${pos.shortPct}%` }} />
                </div>
                <div className="num flex justify-between text-[11px] text-subtle-foreground">
                  <span>
                    <span className="text-positive">{`${pos.longPct.toFixed(2)}% ▪ ${t("common.long")}`}</span> {usd2(pos.long)}
                  </span>
                  <span>
                    {usd2(pos.short)} <span className="text-negative">{`${t("common.short")} ▪ ${pos.shortPct.toFixed(2)}%`}</span>
                  </span>
                </div>
              </>
            ) : (
              <Sub>{t("trader.insightsTab.noExposure")}</Sub>
            )}
          </StatCard>
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
            <span className="text-xs text-muted-foreground">{t("trader.insightsTab.composition")}</span>
            <Donut segments={composition} />
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t("trader.insightsTab.positionMix")}</span>
              <Segmented
                variant="pill"
                value={mix}
                onChange={setMix}
                label={t("trader.insightsTab.positionMix")}
                options={[
                  { value: "perp", label: t("trader.accountPerp") },
                  { value: "spot", label: t("trader.accountSpot") },
                ]}
              />
            </div>
            <Donut segments={mixSegments} icons />
          </div>
        </div>
      </Section>

      <Section
        title={t("trader.bestWorst")}
        action={
          <Segmented
            variant="pill"
            value={view}
            onChange={setView}
            label={t("trader.bestWorst")}
            options={[
              { value: "best", label: t("trader.best") },
              { value: "worst", label: t("trader.worst") },
            ]}
          />
        }
      >
        {pending ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : shown.length > 0 ? (
          <ul className="overflow-hidden rounded-2xl border border-border bg-card">
            {shown.map((trade) => (
              <TradeCard key={trade.id} trade={trade} />
            ))}
          </ul>
        ) : (
          <Sub>{t(view === "best" ? "trader.insightsTab.noWins" : "trader.insightsTab.noLosses")}</Sub>
        )}
      </Section>

      <Section title={t("trader.mostTraded")}>
        {pending ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : mostTraded.length > 0 ? (
          <ul className="overflow-hidden rounded-2xl border border-border bg-card">
            {mostTraded.map((coin) => (
              <li key={coin.coin} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
                <CoinIcon coin={coin.coin} size={26} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold">{coinLabel(coin.coin)}</span>
                  <span className="num text-xs text-muted-foreground">{t("trader.nTrades", { count: coin.trades })}</span>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className={cn("num text-sm font-semibold", pnlTone(coin.netPnl))}>{signedUsdShort(coin.netPnl)}</span>
                  <span className="num text-xs text-muted-foreground">{usd2(coin.volume)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Sub>{t("trader.noClosedTrades")}</Sub>
        )}
      </Section>

      {profileCells.length > 0 ? (
        <Section title={t("trader.insightsTab.profile")}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            {profileCells.map((cell) => {
              const Icon = cell.icon;
              return (
                <div key={cell.key} className="flex flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">{cell.label}</dt>
                  <dd className={cn("inline-flex items-center gap-1.5 text-sm font-semibold", cell.cls)} title={cell.hint} data-testid={`profile-${cell.key}`}>
                    {Icon ? <Icon className="size-4" aria-hidden /> : null}
                    {cell.value}
                  </dd>
                </div>
              );
            })}
          </dl>
        </Section>
      ) : null}
    </div>
  );
}
