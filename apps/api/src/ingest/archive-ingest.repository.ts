import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { archiveCoverage, archiveIngestState } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HistoryFillStore } from "../traders/history-fill.store.js";
import { fillStream, type ArchiveFill } from './archive-format.js';
import { HOUR_MS } from '../config/constants/time.js';
import { ARCHIVE_UNTRACKED_GRACE_MS } from '../config/constants/background.js';

export type ArchiveState = typeof archiveIngestState.$inferSelect;
export type IngestDirection = "live" | "backfill";

interface ObjectCommit {
  direction: IngestDirection;
  /** Start of the hour the object holds (epoch ms). */
  hour: number;
  key: string;
  /** Bytes transferred (0 when the object was skipped without a download). */
  bytes: number;
  fillsSeen: number;
  fillsKept: number;
  /** Database time when the participant set was read; rows queued later
   * were not filtered for and must not be marked covered. */
  snapshotAt: Date;
  /** Addresses over the per-hour cap in this object (none unless a cap is set). */
  excluded: string[];
  /** Lowest hour of the backfill window: a pass that reaches it ends. */
  floor: number;
  /** UTC day (YYYY-MM-DD) the bytes are billed to. */
  day: string;
}

const mine = eq(archiveIngestState.chain, CHAIN_DEFAULT);

/** The one definition of the tracked set: every address whose history the
 * product shows or acts on. */
const TRACKED_SET_SQL = sql`
  SELECT address FROM discovery_traders WHERE chain = ${CHAIN_DEFAULT} AND in_pool
  UNION SELECT address FROM kol_traders WHERE chain = ${CHAIN_DEFAULT}
  UNION SELECT address FROM user_favorites WHERE chain = ${CHAIN_DEFAULT}
  UNION SELECT address FROM cohort_members WHERE chain = ${CHAIN_DEFAULT}
  UNION SELECT address FROM leaders WHERE chain = ${CHAIN_DEFAULT} AND active
  UNION SELECT leader_address FROM copy_strategies WHERE chain = ${CHAIN_DEFAULT} AND status <> 'stopped'
`;

/** Cursors and coverage of the archive ingest. Fills share the REST path's
 * `history_fills` key, so one read from both origins is stored once. */
@Injectable()
export class ArchiveIngestRepository {
  private readonly fills: HistoryFillStore;
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {
    this.fills = new HistoryFillStore(db);
  }

  /** Lower-case addresses of the tracked set (see {@link TRACKED_SET_SQL}). */
  async trackedSet(): Promise<string[]> {
    const result = await this.db.execute<{ address: string }>(sql`SELECT DISTINCT lower(address) AS address FROM (${TRACKED_SET_SQL}) tracked ORDER BY 1`);
    return result.rows.map((row) => row.address);
  }

  /**
   * Queues every tracked address that has no coverage row yet; returns how
   * many entered. An active address that left the set is still ingested for
   * `ARCHIVE_UNTRACKED_GRACE_MS` (the pool and cohorts are rebuilt all day,
   * and an address at their edge comes back), then its row is deleted: the
   * live cursor no longer reads for it, and with no active coverage its
   * history job is no longer `known`, so the job's expiry reclaims its fills.
   * Copied leaders are in the set while their copy runs, so never leave it.
   * An excluded row is left as it is. One statement, so every part sees one
   * snapshot of the set (a data-modifying part runs even if nothing reads it).
   */
  async syncTrackedSet(): Promise<number> {
    const result = await this.db.execute<{ entered: number }>(sql`
      WITH tracked AS MATERIALIZED (
        SELECT DISTINCT lower(address) AS address FROM (${TRACKED_SET_SQL}) tracked WHERE address IS NOT NULL
      ), entered AS (
        INSERT INTO archive_coverage (chain, address) SELECT ${CHAIN_DEFAULT}, address FROM tracked
        ON CONFLICT DO NOTHING RETURNING 1
      ), returned AS (
        UPDATE archive_coverage c SET untracked_since = NULL
        WHERE c.chain = ${CHAIN_DEFAULT} AND c.untracked_since IS NOT NULL AND EXISTS (SELECT 1 FROM tracked t WHERE t.address = c.address)
      ), departed AS (
        UPDATE archive_coverage c SET untracked_since = now()
        WHERE c.chain = ${CHAIN_DEFAULT} AND c.status = 'active' AND c.untracked_since IS NULL AND NOT EXISTS (SELECT 1 FROM tracked t WHERE t.address = c.address)
      ), dropped AS (
        DELETE FROM archive_coverage c
        WHERE c.chain = ${CHAIN_DEFAULT} AND c.status = 'active' AND c.untracked_since < now() - ${ARCHIVE_UNTRACKED_GRACE_MS} * interval '1 millisecond'
          AND NOT EXISTS (SELECT 1 FROM tracked t WHERE t.address = c.address)
      )
      SELECT (SELECT count(*) FROM entered)::int AS entered`);
    return result.rows[0]?.entered ?? 0;
  }

  /** Explicit admission (same effect as the next sync), for callers that
   * know an address just entered the set. */
  async enqueue(addresses: string[]): Promise<void> {
    const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
    for (let i = 0; i < unique.length; i += 1000) {
      await this.db.insert(archiveCoverage).values(unique.slice(i, i + 1000).map((address) => ({ address }))).onConflictDoNothing();
    }
  }

  /** The single state row, created on first use (reads stay read-only after that). */
  async state(): Promise<ArchiveState> {
    const [existing] = await this.db.select().from(archiveIngestState).where(mine);
    if (existing) return existing;
    await this.db.insert(archiveIngestState).values({ chain: CHAIN_DEFAULT }).onConflictDoNothing();
    return (await this.db.select().from(archiveIngestState).where(mine))[0];
  }

  /** Sets a cursor outside an object commit (first run, new backfill pass).
   * `undefined`: another worker moved the state first. */
  async moveCursor(state: ArchiveState, patch: Partial<Pick<ArchiveState, "liveNextHour" | "backfillCursorHour" | "backfillPassStartedAt">>): Promise<ArchiveState | undefined> {
    return (await this.db.update(archiveIngestState).set({ ...patch, version: state.version + 1 })
      .where(and(mine, eq(archiveIngestState.version, state.version))).returning())[0];
  }

  /**
   * Addresses an object must be filtered for, and the database time of the
   * read. Live: every active address. Backfill at `hour`: the active
   * addresses whose span starts right after it (the pass extends spans
   * backward one contiguous hour at a time).
   */
  async participants(direction: IngestDirection, hour: number): Promise<{ addresses: Set<string>; snapshotAt: Date }> {
    return this.db.transaction(async (tx) => {
      const [{ now }] = (await tx.execute<{ now: Date }>(sql`SELECT now() AS now`)).rows;
      const rows = await tx.select({ address: archiveCoverage.address }).from(archiveCoverage).where(and(
        eq(archiveCoverage.chain, CHAIN_DEFAULT), eq(archiveCoverage.status, "active"),
        direction === "backfill" ? eq(archiveCoverage.coveredFrom, new Date(hour + HOUR_MS)) : undefined,
      ));
      return { addresses: new Set(rows.map((row) => row.address)), snapshotAt: new Date(now) };
    }, { isolationLevel: "repeatable read" });
  }

  /** Stores kept fills. Idempotent and safe before the object commits: a
   * fill outside certified coverage is still a true fill. */
  async insertFills(fills: ArchiveFill[]): Promise<void> {
    await this.fills.insert(fills.map(({ address, fill }) => ({ address, source: fillStream(fill), origin: "s3" as const, fill })));
  }

  /** Where the next backfill pass starts: the hour before the latest span
   * start that is still above the floor; null when every span reaches it. */
  async backfillStart(floor: number): Promise<number | null> {
    const [row] = await this.db.select({ latest: sql<Date | null>`max(${archiveCoverage.coveredFrom})` }).from(archiveCoverage).where(and(
      eq(archiveCoverage.chain, CHAIN_DEFAULT), eq(archiveCoverage.status, "active"), gt(archiveCoverage.coveredFrom, new Date(floor)),
    ));
    return row?.latest ? new Date(row.latest).getTime() - HOUR_MS : null;
  }

  /**
   * One object's outcome, atomically: the cursor, the coverage it adds and
   * the transfer accounting. The version check makes a worker that lost
   * ownership store nothing (`undefined`); its fills were idempotent.
   */
  async commitObject(state: ArchiveState, commit: ObjectCommit): Promise<ArchiveState | undefined> {
    const hour = new Date(commit.hour);
    const next = new Date(commit.hour + HOUR_MS);
    return this.db.transaction(async (tx) => {
      const sameDay = state.spendDay === commit.day;
      const backfillNext = commit.hour - HOUR_MS >= commit.floor ? new Date(commit.hour - HOUR_MS) : null;
      const [saved] = await tx.update(archiveIngestState).set({
        ...(commit.direction === "live" ? { liveNextHour: next } : { backfillCursorHour: backfillNext }),
        objects: state.objects + (commit.bytes > 0 ? 1 : 0),
        bytes: state.bytes + commit.bytes,
        fillsSeen: state.fillsSeen + commit.fillsSeen,
        fillsKept: state.fillsKept + commit.fillsKept,
        spendDay: commit.day,
        spendDayBytes: (sameDay ? state.spendDayBytes : 0) + commit.bytes,
        lastObjectKey: commit.key,
        lastObjectAt: new Date(),
        lastRunAt: new Date(),
        lastError: null,
        version: state.version + 1,
      }).where(and(mine, eq(archiveIngestState.version, state.version))).returning();
      if (!saved) return undefined;
      const scope = and(eq(archiveCoverage.chain, CHAIN_DEFAULT), eq(archiveCoverage.status, "active"), lte(archiveCoverage.queuedAt, commit.snapshotAt));
      for (let i = 0; i < commit.excluded.length; i += 1000) {
        await tx.update(archiveCoverage).set({ status: "excluded" }).where(and(
          eq(archiveCoverage.chain, CHAIN_DEFAULT), inArray(archiveCoverage.address, commit.excluded.slice(i, i + 1000)),
        ));
      }
      if (commit.direction === "live") {
        // Contiguous spans grow; an address seen for the first time starts one.
        await tx.update(archiveCoverage).set({ coveredThrough: next }).where(and(scope, eq(archiveCoverage.coveredThrough, hour)));
        await tx.update(archiveCoverage).set({ coveredFrom: hour, coveredThrough: next }).where(and(scope, isNull(archiveCoverage.coveredFrom)));
      } else if (saved.retainedFrom === null || commit.hour >= saved.retainedFrom.getTime()) {
        // Never below the retention cut: fills there are being deleted. The
        // state row is locked by this transaction, so the cut read is current.
        await tx.update(archiveCoverage).set({ coveredFrom: hour }).where(and(scope, eq(archiveCoverage.coveredFrom, next)));
      }
      return saved;
    });
  }

  /** Records a run that stopped early. `code` is a fixed word, never
   * provider text; null clears it. */
  async note(code: string | null): Promise<void> {
    await this.db.update(archiveIngestState).set({ lastError: code, lastRunAt: new Date() }).where(mine);
  }

  async coverageCounts(floor: number): Promise<{ total: number; backfilled: number; pending: number; excluded: number }> {
    const [row] = (await this.db.execute<{ total: string; backfilled: string; excluded: string }>(sql`
      SELECT count(*) AS total,
        count(*) FILTER (WHERE status = 'active' AND covered_from <= ${new Date(floor)}) AS backfilled,
        count(*) FILTER (WHERE status = 'excluded') AS excluded
      FROM archive_coverage WHERE chain = ${CHAIN_DEFAULT}`)).rows;
    const total = Number(row.total);
    const backfilled = Number(row.backfilled);
    const excluded = Number(row.excluded);
    return { total, backfilled, excluded, pending: total - backfilled - excluded };
  }
}
