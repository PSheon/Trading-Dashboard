"use client";

import type { HeartbeatResponse, OperationalSwitches } from "@/lib/contracts";
import { Panel } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";

type Archive = NonNullable<HeartbeatResponse["archive"]>;

/** Which of the ingest's states the worker's heartbeat describes. */
export function archiveState(enabled: boolean | undefined, archive: Archive | undefined): "disabled" | "running" | "capped" | "error" | "unknown" {
  if (enabled === false) return "disabled";
  if (!archive) return "unknown";
  if (!archive.enabled) return "disabled";
  if (archive.spendDayUsd >= archive.maxDailyUsd) return "capped";
  return archive.lastError ? "error" : "running";
}

/**
 * The switches each process was started with (review finding 19): read-only,
 * the api's next to the worker's, because the two can be configured
 * differently and TELEGRAM_DRY_RUN and the archive ingest matter in the
 * worker. Then the archive ingest's state and today's spend against its cap,
 * from the worker's heartbeat.
 */
export function OperationalSwitchesPanel({ api, worker, archive }: { api?: OperationalSwitches; worker?: OperationalSwitches; archive?: Archive }) {
  const { t, format } = useI18n();
  if (!api) return null;
  const onOff = (v: boolean) => t(v ? "adminOps.system.on" : "adminOps.system.off");
  const rows: { name: string; value: (s: OperationalSwitches) => React.ReactNode }[] = [
    { name: "IS_WORKER", value: (s) => String(s.isWorker) },
    { name: "COPY_TRADING_MODE", value: (s) => s.copyTradingMode },
    { name: "HYPERLIQUID_NETWORK", value: (s) => s.hyperliquidNetwork },
    { name: "TELEGRAM_DRY_RUN", value: (s) => t(s.telegramDryRun ? "adminOps.system.dryRunOn" : "adminOps.system.dryRunOff") },
    { name: "S3_ARCHIVE_ENABLED", value: (s) => onOff(s.archiveEnabled) },
    { name: "S3_ARCHIVE_MAX_DAILY_USD", value: (s) => format.usd(s.archiveMaxDailyUsd, { digits: 2 }) },
    { name: "MAX_FAVORITES_PER_USER", value: (s) => t("adminOps.system.favoritesDefault", { value: s.maxFavoritesPerUserDefault }) },
  ];
  // The ingest runs in the worker.
  const state = archiveState(worker?.archiveEnabled, archive);
  return (
    <Panel className="overflow-hidden" aria-labelledby="switches-title">
      <div className="p-5 pb-3">
        <h3 id="switches-title" className="font-semibold">{t("adminOps.system.title")}</h3>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t("adminOps.system.hint")}</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("adminOps.system.switch")}</TableHead>
            <TableHead>{t("adminOps.system.api")}</TableHead>
            <TableHead>{t("adminOps.system.worker")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell className="font-mono text-xs">{row.name}</TableCell>
              <TableCell className="whitespace-normal">{row.value(api)}</TableCell>
              <TableCell className="whitespace-normal">{worker ? row.value(worker) : <span className="text-muted-foreground">{t("adminOps.system.notReported")}</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="border-t-2 border-dotted border-border p-5">
        <h4 className="text-sm font-semibold">{t("adminOps.system.archiveTitle")}</h4>
        <dl className="mt-2 divide-y-2 divide-dotted divide-border text-xs">
          <Fact label={t("adminOps.system.archiveState")} value={t(`adminOps.system.archiveStates.${state}`)} />
          {archive?.enabled ? (
            <>
              <Fact label={t("adminOps.system.archiveSpend")} value={t("adminOps.system.archiveSpendValue", { spent: format.usd(archive.spendDayUsd, { digits: 4 }), cap: format.usd(archive.maxDailyUsd, { digits: 2 }) })} />
              <Fact label={t("adminOps.system.archiveLag")} value={archive.lagSeconds === null ? "—" : format.duration(archive.lagSeconds)} />
              <Fact label={t("adminOps.system.archiveLastRun")} value={archive.lastRunAt ? format.dateTime(archive.lastRunAt) : "—"} />
              <Fact label={t("adminOps.system.archiveCoverage")} value={t("adminOps.system.archiveCoverageValue", { done: archive.addresses.backfilled, total: archive.addresses.total - archive.addresses.excluded })} />
              <Fact label={t("adminOps.system.archivePending")} value={archive.addresses.pending} />
              <Fact label={t("adminOps.system.archiveExcluded")} value={archive.addresses.excluded} />
              <Fact label={t("adminOps.system.archiveTarget")} value={archive.backfillFloor ? <time dateTime={new Date(archive.backfillFloor).toISOString()}>{new Date(archive.backfillFloor).toISOString()}</time> : "—"} />
              <Fact label={t("adminOps.system.archiveCursor")} value={archive.backfillCursorHour ? <time dateTime={new Date(archive.backfillCursorHour).toISOString()}>{new Date(archive.backfillCursorHour).toISOString()}</time> : "—"} />
              <Fact label={t("adminOps.system.archiveLiveThrough")} value={archive.liveNextHour ? <time dateTime={new Date(archive.liveNextHour).toISOString()}>{new Date(archive.liveNextHour).toISOString()}</time> : "—"} />
              {archive.lastError ? <Fact label={t("adminOps.system.archiveLastError")} value={archive.lastError} /> : null}
            </>
          ) : null}
        </dl>
        {archive?.enabled ? <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("adminOps.system.archiveCoverageHint")}</p> : null}
      </div>
    </Panel>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num break-words text-right">{value}</dd>
    </div>
  );
}
