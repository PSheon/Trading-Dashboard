"use client";

import type { ActionKind } from "@/lib/contracts";
import { Activity, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { ACTION_KINDS, ActionsTable } from "@/components/actions/actions-table";
import { LiveBadge } from "@/components/actions/live-badge";
import { EmptyState, ErrorState, Panel } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { useLiveActions } from "@/lib/queries";
import { CrowdView } from "@/components/insights/crowd-view";
import { TableSkeleton } from "@/components/ui/table-skeleton";

const TIERS = ["A", "B", "C"] as const;

const selectClass =
  "h-10 rounded-full bg-raised px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 營運: the site-wide live action stream and the crowd view, moved here
 * from 洞察 (Stage 3 §3.2); users see their favorites' moves under
 * 收藏 → 動態 and on trader pages. */
export function AdminActivity() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [coin, setCoin] = useState(params.get("coin") ?? "");
  const [kind, setKind] = useState<ActionKind | "">("");
  const [tier, setTier] = useState("");

  // Market chips on Home link here with ?coin=.
  const urlCoin = params.get("coin") ?? "";
  const [seenUrlCoin, setSeenUrlCoin] = useState(urlCoin);
  if (urlCoin !== seenUrlCoin) {
    setSeenUrlCoin(urlCoin);
    setCoin(urlCoin);
  }

  const coinFilter = coin.trim().toUpperCase();
  const { query: actions, status: streamStatus, highlight } = useLiveActions({
    coin: coinFilter || undefined,
    kind: kind || undefined,
    tier: tier || undefined,
    limit: 100,
  });
  const filtered = Boolean(coinFilter || kind || tier);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t("insights.subtitle")}</p>

      <CrowdView onCoin={(c) => setCoin(c)} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="mr-2 flex items-center gap-2 text-lg font-bold">
            {t("insights.liveFeed")}
            <LiveBadge status={streamStatus} />
          </h2>
          <input
            value={coin}
            onChange={(e) => setCoin(e.target.value)}
            placeholder={t("insights.coin")}
            aria-label={t("insights.coin")}
            className="h-10 w-44 rounded-full bg-raised px-4 text-sm outline-none placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ActionKind | "")}
            aria-label={t("insights.allKinds")}
            className={selectClass}
          >
            <option value="" className="bg-popover">
              {t("insights.allKinds")}
            </option>
            {ACTION_KINDS.map((k) => (
              <option key={k} value={k} className="bg-popover">
                {t(`actions.kinds.${k}`)}
              </option>
            ))}
          </select>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            aria-label={t("insights.allTiers")}
            className={selectClass}
          >
            <option value="" className="bg-popover">
              {t("insights.allTiers")}
            </option>
            {TIERS.map((tr) => (
              <option key={tr} value={tr} className="bg-popover">
                {t("insights.tier", { tier: tr })}
              </option>
            ))}
          </select>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCoin("");
                setKind("");
                setTier("");
              }}
            >
              <X />
              {t("insights.clearFilters")}
            </Button>
          ) : null}
        </div>

        <Panel className="overflow-hidden">
          {actions.isError ? (
            <ErrorState message={actions.error.message} onRetry={() => actions.refetch()} />
          ) : !actions.data ? (
            <TableSkeleton
              rows={8}
              columns={[
                { label: t("actions.cols.time") },
                { label: t("actions.cols.trader"), bar: "w-28" },
                { label: t("actions.cols.coin") },
                { label: t("actions.cols.action") },
                { label: t("actions.cols.side") },
                { label: t("actions.cols.notional"), right: true },
                { label: t("actions.cols.leverage"), right: true, className: "hidden sm:table-cell" },
                { label: t("actions.cols.price"), right: true, className: "hidden md:table-cell" },
              ]}
            />
          ) : actions.data.length === 0 ? (
            <EmptyState icon={Activity} title={t("insights.empty")} />
          ) : (
            <ActionsTable rows={actions.data} highlight={highlight} />
          )}
        </Panel>
      </section>
    </div>
  );
}
