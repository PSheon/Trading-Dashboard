"use client";

import { Activity, Star } from "lucide-react";
import Link from "next/link";

import { ActionsTable } from "@/components/actions/actions-table";
import { EmptyState, ErrorState, PageHeader, Panel, SectionHeader, SignInPrompt, Skeleton } from "@/components/page";
import { TraderCard } from "@/components/traders/trader-card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { useActions, useFavorites, useSparklines } from "@/lib/queries";

export function FavoritesView() {
  const { t } = useI18n();
  const { status } = useAuth();
  const signedIn = status === "signedIn";
  const favorites = useFavorites();
  const actions = useActions({ scope: "favorites", limit: 50 }, { enabled: signedIn });
  const sparklines = useSparklines(favorites.data?.map((f) => f.address).slice(0, 30) ?? [], "month");

  if (!signedIn) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("favorites.title")} subtitle={t("favorites.subtitle")} />
        <Panel>
          <SignInPrompt icon={Star} title={t("favorites.signInTitle")} body={t("favorites.signInBody")} />
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("favorites.title")} subtitle={t("favorites.subtitle")} />

      <section>
        <SectionHeader title={t("favorites.traders")} />
        {favorites.isError ? (
          <Panel>
            <ErrorState message={favorites.error.message} onRetry={() => favorites.refetch()} />
          </Panel>
        ) : !favorites.data ? (
          <div className="flex gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[178px] w-[206px] rounded-2xl" />
            ))}
          </div>
        ) : favorites.data.length === 0 ? (
          <Panel>
            <EmptyState
              icon={Star}
              title={t("favorites.emptyTitle")}
              body={t("favorites.emptyBody")}
              action={
                <Button asChild variant="secondary">
                  <Link href="/explore">{t("home.browse")}</Link>
                </Button>
              }
            />
          </Panel>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-3">
            {favorites.data.map((f) => (
              <TraderCard
                key={f.address}
                className="w-auto md:w-auto"
                trader={{
                  address: f.address,
                  displayName: f.stats?.displayName ?? null,
                  isVault: f.stats?.isVault ?? false,
                  pnl: f.stats?.pnl.month ?? null,
                  roi: f.stats?.roi.month ?? null,
                }}
                series={sparklines.data?.[f.address]}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeader title={t("favorites.recentActions")} />
        <Panel className="overflow-hidden">
          {actions.isError ? (
            <ErrorState message={actions.error.message} onRetry={() => actions.refetch()} />
          ) : !actions.data ? (
            <div className="flex flex-col gap-2 p-5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : actions.data.length === 0 ? (
            <EmptyState icon={Activity} title={t("favorites.noActions")} />
          ) : (
            <ActionsTable rows={actions.data} />
          )}
        </Panel>
      </section>
    </div>
  );
}
