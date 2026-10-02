"use client";

import { Users } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { EmptyState, ErrorState, Panel, Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { coinLabel } from "@/lib/format";
import { useCrowd } from "@/lib/queries";

const COLLAPSED = 10;

/**
 * Crowd view (競品分析 §3.4): per coin, what the watched traders hold —
 * short notional growing left in red, long growing right in green, the
 * trader counts, net bias and how the net position moved in 24 h.
 */
export function CrowdView({ onCoin }: { onCoin: (coin: string) => void }) {
  const { t, format } = useI18n();
  const crowd = useCrowd();
  const [all, setAll] = useState(false);

  if (crowd.isError && !crowd.data) {
    return (
      <Panel>
        <ErrorState message={crowd.error.message} onRetry={() => crowd.refetch()} />
      </Panel>
    );
  }
  if (!crowd.data) return <Skeleton className="h-[420px] rounded-2xl" />;

  const coins = crowd.data.coins;
  const shown = all ? coins : coins.slice(0, COLLAPSED);
  const max = Math.max(1, ...shown.map((c) => Math.max(c.longNotional ?? 0, c.shortNotional ?? 0)));

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-bold tracking-tight">{t("insights.crowdTitle")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("insights.crowdSubtitle", { count: crowd.data.trackedTraders })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {crowd.data.comparison
              ? t("insights.crowdComparison", { matched: crowd.data.comparison.matchedTraders, current: crowd.data.comparison.currentTraders, past: crowd.data.comparison.pastTraders })
              : t("insights.crowdComparisonUnavailable")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t("insights.crowdExposureHint")}</p>
        </div>
        {crowd.data.updatedAt ? (
          <span className="num text-[11px] text-subtle-foreground">
            {t("insights.crowdUpdated", { time: format.relative(crowd.data.updatedAt) })}
          </span>
        ) : null}
      </div>

      {coins.length === 0 ? (
        <EmptyState icon={Users} title={t("insights.crowdEmpty")} />
      ) : (
        <div className="overflow-x-auto no-scrollbar">
          <div className="min-w-[680px]">
            <div className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)_110px_90px_110px] gap-3 px-5 pt-3 pb-2 text-[11px] font-medium text-subtle-foreground">
              <span>{t("insights.crowdCols.coin")}</span>
              <span className="text-right">{t("insights.crowdCols.short")}</span>
              <span>{t("insights.crowdCols.long")}</span>
              <span className="text-right">{t("insights.crowdCols.traders")}</span>
              <span className="text-right">{t("insights.crowdCols.bias")}</span>
              <span className="text-right">{t("insights.crowdCols.change")}</span>
            </div>
            <ul>
              {shown.map((c) => {
                // Never derive a delta from totals over potentially different cohorts.
                const change = c.netNotionalChange24h ?? null;
                const biasPct = Math.abs(c.netBias ?? 0);
                return (
                  <li key={c.coin}>
                    <button
                      type="button"
                      onClick={() => onCoin(coinLabel(c.coin))}
                      className="num grid w-full grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)_110px_90px_110px] items-center gap-3 px-5 py-2.5 text-left text-[0.8125rem] outline-none transition-colors hover:bg-raised/60 focus-visible:bg-raised"
                    >
                      <span className="flex min-w-0 items-center gap-2 font-semibold">
                        <CoinIcon coin={c.coin} size={20} />
                        <span className="truncate">{coinLabel(c.coin)}</span>
                      </span>
                      <span className="flex items-center justify-end gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {c.shortNotional === null ? "—" : format.usd(c.shortNotional, { compact: true })}
                        </span>
                        <span
                          className="h-5 rounded-l-md bg-negative/80"
                          style={{ width: `${((c.shortNotional ?? 0) / max) * 70}%` }}
                        />
                      </span>
                      <span className="flex items-center gap-2 border-l border-border-strong pl-0">
                        <span
                          className="h-5 rounded-r-md bg-positive/80"
                          style={{ width: `${((c.longNotional ?? 0) / max) * 70}%` }}
                        />
                        <span className="text-[11px] text-muted-foreground">
                          {c.longNotional === null ? "—" : format.usd(c.longNotional, { compact: true })}
                        </span>
                      </span>
                      <span className="text-right text-xs">
                        <span className="text-positive">{t("insights.longTraders", { count: c.longTraders })}</span>
                        <span className="text-subtle-foreground"> / </span>
                        <span className="text-negative">{t("insights.shortTraders", { count: c.shortTraders })}</span>
                      </span>
                      <span className="text-right">
                        <span
                          className={cn(
                            "inline-flex h-6 items-center rounded-full px-2 text-[11px] font-semibold",
                            biasPct < 0.05
                              ? "bg-raised text-muted-foreground"
                              : (c.netBias ?? 0) > 0
                                ? "bg-positive-soft text-positive"
                                : "bg-negative-soft text-negative",
                          )}
                        >
                          {c.netBias === null ? "—" : biasPct < 0.05
                            ? t("insights.biasFlat")
                            : t((c.netBias ?? 0) > 0 ? "insights.biasLong" : "insights.biasShort", {
                                value: format.pct(biasPct, { digits: 0 }),
                              })}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "text-right font-semibold",
                          change === null ? "text-subtle-foreground" : change >= 0 ? "text-positive" : "text-negative",
                        )}
                      >
                        {change === null ? "—" : format.usd(change, { compact: true, sign: true })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
      {coins.length > COLLAPSED ? (
        <div className="border-t border-border px-5 py-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)}>
            {all ? t("common.collapse") : `${t("common.expand")} (${coins.length})`}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
