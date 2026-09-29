"use client";

import type { Favorite, SparklinesResponse } from "@/lib/contracts";
import { Activity, BellRing, Star, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";

import { ActionsTable } from "@/components/actions/actions-table";
import { LiveBadge } from "@/components/actions/live-badge";
import { AlertBell } from "@/components/alerts/alert-bell";
import { AreaChart } from "@/components/charts/area-chart";
import { EmptyState, ErrorState, PageHeader, Panel, SectionHeader, SignInPrompt, Skeleton } from "@/components/page";
import { AddressAvatar } from "@/components/traders/address-avatar";
import { FavoriteButton, PnlValue, VaultBadge } from "@/components/traders/bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { useTelegramStatus } from "@/lib/alerts";
import { useAuth } from "@/lib/auth";
import { traderName, truncateAddress } from "@/lib/format";
import { useFavorites, useLiveActions, useSiteSettings, useSparklines } from "@/lib/queries";

export function FavoritesView() {
  const { t } = useI18n();
  const { status } = useAuth();
  const signedIn = status === "signedIn";
  const favorites = useFavorites();
  const settings = useSiteSettings();
  const telegram = useTelegramStatus();
  const { query: actions, status: streamStatus, highlight } = useLiveActions({ scope: "favorites", limit: 50 }, { enabled: signedIn });
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

  const alerting = favorites.data?.filter((f) => f.alert.enabled).length ?? 0;
  const max = settings.data?.maxAlertTraders;
  const tg = telegram.data;
  const undeliverable = alerting > 0 && tg !== undefined && (!tg.linked || !tg.enabled);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("favorites.title")} subtitle={t("favorites.subtitle")} />

      <section className="flex flex-col gap-3">
        <SectionHeader
          className="mb-0.5"
          title={t("favorites.traders")}
          action={
            favorites.data && max !== undefined ? (
              <span
                className={cn(
                  "num inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold",
                  alerting > 0 ? "bg-primary-soft text-primary" : "bg-raised text-muted-foreground",
                )}
              >
                <BellRing className="size-3.5" />
                {t("alerts.count", { count: alerting, max })}
              </span>
            ) : null
          }
        />

        {undeliverable ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-warning/25 bg-warning/8 px-4 py-3 text-[0.8125rem] text-warning">
            <TriangleAlert className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("alerts.undeliverable", { count: alerting })}</span>
            <Button asChild size="sm" variant="secondary">
              <Link href="/settings">{t("alerts.goSettings")}</Link>
            </Button>
          </div>
        ) : null}

        {favorites.isError ? (
          <Panel>
            <ErrorState message={favorites.error.message} onRetry={() => favorites.refetch()} />
          </Panel>
        ) : !favorites.data ? (
          <Panel className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </Panel>
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
          <Panel className="overflow-hidden">
            <FavoritesTable rows={favorites.data} sparklines={sparklines.data} />
          </Panel>
        )}
      </section>

      <section>
        <SectionHeader
          title={
            <span className="flex items-center gap-2">
              {t("favorites.recentActions")}
              <LiveBadge status={streamStatus} />
            </span>
          }
        />
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
            <ActionsTable rows={actions.data} highlight={highlight} />
          )}
        </Panel>
      </section>
    </div>
  );
}

/** One row per favorite (CopyDog watchlist density): the trader, 30-day
 * figures, and the alert bell with its current setting. */
function FavoritesTable({ rows, sparklines }: { rows: Favorite[]; sparklines: SparklinesResponse | undefined }) {
  const { t, format } = useI18n();
  const router = useRouter();

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("favorites.cols.trader")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("favorites.cols.accountValue")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("favorites.cols.pnl")}</TableHead>
          <TableHead className="hidden text-right lg:table-cell">{t("favorites.cols.roi")}</TableHead>
          <TableHead className="hidden w-36 text-right xl:table-cell">{t("favorites.cols.trend")}</TableHead>
          <TableHead className="text-right">{t("favorites.cols.alert")}</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((f) => {
          const name = traderName({ address: f.address, displayName: f.stats?.displayName ?? null });
          const roi = f.stats?.roi.month ?? null;
          const series = sparklines?.[f.address];
          return (
            <TableRow key={f.address} className="cursor-pointer" onClick={() => router.push(`/trader/${f.address}`)}>
              <TableCell>
                <Link
                  href={`/trader/${f.address}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex min-w-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AddressAvatar seed={f.address} size={30} />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="max-w-[7.5rem] truncate font-semibold text-foreground sm:max-w-[14rem]">{name}</span>
                      {f.stats?.isVault ? <VaultBadge /> : null}
                    </span>
                    <span className="font-mono text-[11px] text-subtle-foreground">
                      {f.stats?.displayName ? truncateAddress(f.address) : null}
                      <span className="sm:hidden">
                        {f.stats?.displayName ? " · " : ""}
                        <PnlValue value={f.stats?.pnl.month ?? null} className="font-sans text-[11px]" />
                      </span>
                    </span>
                  </span>
                </Link>
              </TableCell>
              <TableCell className="hidden text-right md:table-cell">
                {format.usd(f.stats?.accountValue ?? null, { compact: true })}
              </TableCell>
              <TableCell className="hidden text-right sm:table-cell">
                <PnlValue value={f.stats?.pnl.month ?? null} />
              </TableCell>
              <TableCell
                className={cn(
                  "hidden text-right font-semibold lg:table-cell",
                  roi === null || roi === 0 ? "text-foreground" : roi > 0 ? "text-positive" : "text-negative",
                )}
              >
                {format.pct(roi, { sign: true })}
              </TableCell>
              <TableCell className="hidden py-1.5 xl:table-cell">
                <div className="ml-auto w-32">
                  {series?.length ? <AreaChart data={series} height={34} strokeWidth={1.5} /> : <div className="h-[34px]" />}
                </div>
              </TableCell>
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                <AlertBell address={f.address} variant="pill" />
              </TableCell>
              <TableCell className="pl-0 text-right" onClick={(e) => e.stopPropagation()}>
                <FavoriteButton address={f.address} favorite size="sm" />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
