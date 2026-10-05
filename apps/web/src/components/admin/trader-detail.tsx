"use client";
import { Link } from "@/i18n/navigation";
import { useQuery } from "@tanstack/react-query";
import type { AdminTrader } from "@/lib/contracts";
import { api } from "@/lib/api";
import { useI18n } from "@/i18n/provider";
import { usePermission } from "@/lib/auth";
import { ErrorState, Panel, PanelSkeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

/** One address across every table (the old 交易員診斷 page), shown in the
 * 交易者資料 tab's drawer. */
export function TraderDiagnosis({ address }: { address: string }) {
  const valid = /^0x[0-9a-f]{40}$/.test(address);
  const allowed = usePermission("traders.read");
  const { t } = useI18n();
  const result = useQuery({
    queryKey: ["admin", "trader", address],
    enabled: allowed && valid,
    queryFn: ({ signal }) => api.get<AdminTrader>(`/admin/traders/hyperliquid/${address}`, signal),
    refetchInterval: 30_000,
  });
  if (!valid) return <p className="text-sm font-bold text-muted-foreground">{t("adminTrader.enterAddress")}</p>;
  if (result.isError) return <ErrorState message={result.error.message} onRetry={() => result.refetch()} />;
  if (!result.data) return <PanelSkeleton tiles={4} rows={4} />;
  return <TraderEvidence data={result.data} refreshing={result.isFetching} onRefresh={() => void result.refetch()} />;
}

function TraderEvidence({
  data: d,
  refreshing,
  onRefresh,
}: {
  data: AdminTrader;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t, format } = useI18n();
  const date = (v: string | null | undefined) =>
    v ? format.dateTime(v) : t("adminTrader.missing");
  const yes = (v: boolean) => t(v ? "adminTrader.yes" : "adminTrader.no");
  const a = d.analytics;
  const metrics = [
    [
      t("adminTrader.leaderboard"),
      null,
      d.identity.leaderboardUpdatedAt,
      t("adminTrader.storedTime"),
    ],
    [
      t("adminTrader.portfolio"),
      null,
      d.discovery?.portfolioAt,
      t("adminTrader.storedTime"),
    ],
    [
      t("adminTrader.discoveryTrades"),
      null,
      d.discovery?.tradesAt,
      t("adminTrader.storedTime"),
    ],
    [
      t("adminTrader.fills"),
      d.fills.firstAt,
      d.fills.lastAt,
      t("adminTrader.fillHint"),
    ],
    [
      t("adminTrader.analytics"),
      a?.coverageFrom,
      a?.historyThrough,
      a
        ? `${t("adminTrader.fillCount")}: ${a.fillsRead} · ${t("adminTrader.truncated")}: ${yes(a.truncated)}`
        : t("adminTrader.missing"),
    ],
    [
      t("adminTrader.funding"),
      a?.fundingFrom,
      a?.fundingThrough,
      t("adminTrader.coverageOnly"),
    ],
  ];
  return (
    <>
      <Panel className="card-pad space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="type-h2">
              {d.identity.displayName ?? t("adminTrader.unlabelled")}
            </h3>
            <p className="mt-1 break-all font-mono text-xs">{d.address}</p>
            {d.identity.xHandle && (
              <p className="mt-1 break-all text-sm text-muted-foreground">
                @{d.identity.xHandle}
              </p>
            )}
          </div>
          <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
            {t("jobs.refresh")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("adminTrader.sampled")}: {date(d.sampledAt)}
        </p>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link href={`/trader/${d.address}`} className="underline">
            {t("adminTrader.profile")}
          </Link>
          <Link href="/admin/jobs" className="underline">
            {t("jobs.title")}
          </Link>
          <Link href="/admin/system" className="underline">
            {t("admin.nav.system")}
          </Link>
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="card-pad space-y-3">
          <h3 className="type-h2">{t("adminTrader.sources")}</h3>
          <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 text-sm">
            <dt>{t("adminTrader.kol")}</dt>
            <dd>{yes(d.identity.kolRegistered)}</dd>
            <dt>{t("adminTrader.leaderboard")}</dt>
            <dd>{yes(Boolean(d.identity.leaderboardUpdatedAt))}</dd>
            <dt>{t("adminTrader.pool")}</dt>
            <dd>
              {d.discovery ? yes(d.discovery.inPool) : t("adminTrader.missing")}
            </dd>
            <dt>{t("adminTrader.rank")}</dt>
            <dd>{d.discovery?.poolRank ?? t("adminTrader.missing")}</dd>
            <dt>{t("adminTrader.watch")}</dt>
            <dd>
              {d.watch
                ? t(
                    d.watch.active
                      ? "adminTrader.active"
                      : "adminTrader.inactive",
                  )
                : t("adminTrader.noWatcher")}
            </dd>
            <dt>{t("adminTrader.watchSource")}</dt>
            <dd className="break-all">
              {d.watch?.source ?? t("adminTrader.missing")}
            </dd>
            <dt>{t("adminTrader.favorites")}</dt>
            <dd>{d.references.favorites}</dd>
            <dt>{t("adminTrader.alerts")}</dt>
            <dd>{d.references.alerts}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            {t("adminTrader.sourceHint")}
          </p>
        </Panel>
        <Panel className="card-pad space-y-3">
          <h3 className="type-h2">{t("adminTrader.operations")}</h3>
          <dl className="space-y-2 text-sm">
            <dt className="text-muted-foreground">
              {t("adminTrader.lastAttempt")}
            </dt>
            <dd>{date(d.discovery?.attemptedAt)}</dd>
            <dt className="text-muted-foreground">
              {t("adminTrader.refreshStatus")}
            </dt>
            <dd>
              {d.discovery
                ? t(
                    d.discovery.refreshFailed
                      ? "adminTrader.failed"
                      : "adminTrader.noError",
                  )
                : t("adminTrader.missing")}
            </dd>
            <dt className="text-muted-foreground">
              {t("adminTrader.backfill")}
            </dt>
            <dd>
              {d.backfill
                ? `${t(`jobs.${d.backfill.status}`)} · ${t("adminTrader.attempts")}: ${d.backfill.attempts}`
                : t("adminTrader.missing")}
            </dd>
            <dt className="text-muted-foreground">
              {t("adminTrader.archive")}
            </dt>
            <dd>
              {d.history
                ? t(`adminTrader.history.${d.history.status}`)
                : t("adminTrader.missing")}
              {d.history?.failed && ` · ${t("adminTrader.failed")}`}
            </dd>
            <dt className="text-muted-foreground">
              {t("adminTrader.published")}
            </dt>
            <dd>{date(d.history?.publishedThrough)}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            {t("adminTrader.historyHint")}
          </p>
        </Panel>
      </div>
      <Panel className="overflow-hidden p-4">
        <h3 className="mb-3 font-semibold">{t("adminTrader.coverage")}</h3>
        <Table aria-label={t("adminTrader.coverage")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("adminTrader.dataset")}</TableHead>
              <TableHead>{t("adminTrader.from")}</TableHead>
              <TableHead>{t("adminTrader.through")}</TableHead>
              <TableHead>{t("adminTrader.notes")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {metrics.map(([name, from, through, note]) => (
              <TableRow key={name}>
                <TableCell>{name}</TableCell>
                <TableCell>{date(from)}</TableCell>
                <TableCell>{date(through)}</TableCell>
                <TableCell className="min-w-48 whitespace-normal">
                  {note}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("adminTrader.computed")}: {date(a?.computedAt)} ·{" "}
          {t("adminTrader.analysisSource")}:{" "}
          {a?.source ?? t("adminTrader.missing")}
        </p>
      </Panel>
      <Panel className="card-pad space-y-3">
        <h3 className="type-h2">{t("adminTrader.imports")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("adminTrader.importHint")}
        </p>
        {d.imports.items.length ? (
          <ul className="space-y-2">
            {d.imports.items.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap gap-x-4 gap-y-1 border-b-2 border-dotted border-border py-2 text-sm"
              >
                <span>#{i.id}</span>
                <span className="break-all">{i.source}</span>
                <span>
                  {t("adminTrader.rank")}: {i.rank}
                </span>
                <span className="text-muted-foreground">
                  {date(i.importedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("adminTrader.missing")}</p>
        )}
        {d.imports.hasMore && (
          <p className="text-xs text-muted-foreground">
            {t("adminTrader.more")}
          </p>
        )}
      </Panel>
    </>
  );
}
