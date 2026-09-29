"use client";

import type { ActionKind } from "@/lib/contracts";
import { Activity, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { ACTION_KINDS, ActionsTable } from "@/components/actions/actions-table";
import { EmptyState, ErrorState, PageHeader, Panel, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { useActions } from "@/lib/queries";
import { CrowdView } from "./crowd-view";

const TIERS = ["A", "B", "C"] as const;

const selectClass =
  "h-10 rounded-full bg-raised px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function InsightsView() {
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
  const actions = useActions({ coin: coinFilter || undefined, kind: kind || undefined, tier: tier || undefined, limit: 100 });
  const filtered = Boolean(coinFilter || kind || tier);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("insights.title")} subtitle={t("insights.subtitle")} />

      <CrowdView onCoin={(c) => setCoin(c)} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="mr-2 flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            {t("insights.liveFeed")}
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
            <div className="flex flex-col gap-2 p-5">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : actions.data.length === 0 ? (
            <EmptyState icon={Activity} title={t("insights.empty")} />
          ) : (
            <ActionsTable rows={actions.data} />
          )}
        </Panel>
      </section>
    </div>
  );
}
