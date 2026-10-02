import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { analysisHistoryFills, analysisHistoryJobs, archiveCoverage, discoveryTraders, kolTraders, leaders, userFavorites } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { certifiedSpan, completeCheckpoint, initialCheckpoint, type ArchiveSpan, type HistoryCheckpoint, type HistorySource } from "../analytics/history-checkpoint.js";

export type HistoryJob = typeof analysisHistoryJobs.$inferSelect;
/** Who asks for an address's durable history: the product's own jobs (the
 * discovery pool, the worker), a signed-in person, or an anonymous visitor. */
export type HistoryCaller = "product" | "user" | "anonymous";
/** Pending jobs that may exist at once for addresses only a signed-in
 * person asked for. Each costs worker turns (one job a minute) and stored
 * fills, so the number a few accounts can create is bounded. */
export const MAX_REQUESTED_JOBS = 200;
/** Such a job is deleted, with its fills, this long after it was last asked for. */
export const REQUESTED_JOB_TTL_MS = 14 * 24 * 3_600_000;
/** Jobs removed per expiry pass (their fills go in the same transaction). */
const EXPIRE_BATCH = 50;

/** SQL: `address` is one the product already follows: in the discovery
 * pool, a KOL, watched, favorited by someone, or covered by the archive. */
function known(address: SQL | string): SQL {
  return sql`(
    exists (select 1 from ${discoveryTraders} where ${discoveryTraders.chain} = ${CHAIN_DEFAULT} and ${discoveryTraders.address} = ${address})
    or exists (select 1 from ${kolTraders} where ${kolTraders.chain} = ${CHAIN_DEFAULT} and ${kolTraders.address} = ${address})
    or exists (select 1 from ${leaders} where ${leaders.chain} = ${CHAIN_DEFAULT} and ${leaders.address} = ${address} and ${leaders.active})
    or exists (select 1 from ${userFavorites} where ${userFavorites.chain} = ${CHAIN_DEFAULT} and ${userFavorites.address} = ${address})
    or exists (select 1 from ${archiveCoverage} where ${archiveCoverage.chain} = ${CHAIN_DEFAULT} and ${archiveCoverage.address} = ${address} and ${archiveCoverage.status} = 'active')
  )`;
}
export interface HistorySnapshot { fills: HlUserFill[]; through: Date }
const mine = (address: string) => and(eq(analysisHistoryJobs.chain, CHAIN_DEFAULT), eq(analysisHistoryJobs.address, address));

@Injectable()
export class AnalysisHistoryRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /**
   * Makes sure the address has a durable history job, if `caller` may have
   * one; returns whether it has one afterwards. `from`: where a new job
   * starts reading (default: the start of upstream's history). An existing
   * job keeps its progress and is only marked as asked for again.
   *
   * A job is permanent work: a worker turn a minute and every fill stored.
   * The analytics routes are public, so who may create one is limited:
   * - the product's own jobs, and anyone asking about an address the
   *   product already follows (see `known`): always;
   * - a signed-in person asking about any other address: while fewer than
   *   `MAX_REQUESTED_JOBS` such jobs are pending;
   * - an anonymous visitor asking about any other address: never. Their
   *   answer is still computed from Hyperliquid; it just isn't kept and
   *   continued in the background.
   */
  async ensure(address: string, now = Date.now(), from = 0, caller: HistoryCaller = "product"): Promise<boolean> {
    const touched = await this.db.update(analysisHistoryJobs).set({ requestedAt: new Date(now) }).where(mine(address)).returning({ address: analysisHistoryJobs.address });
    if (touched.length > 0) return true;
    if (caller !== "product" && !(await this.isKnown(address))) {
      if (caller === "anonymous") return false;
      const [row] = await this.db.select({ n: count() }).from(analysisHistoryJobs)
        .where(and(eq(analysisHistoryJobs.chain, CHAIN_DEFAULT), eq(analysisHistoryJobs.status, "pending"), sql`not ${known(sql`${analysisHistoryJobs.address}`)}`));
      if (Number(row?.n ?? 0) >= MAX_REQUESTED_JOBS) return false;
    }
    await this.db.insert(analysisHistoryJobs).values({ address, checkpoint: initialCheckpoint(now, Math.min(from, now)), requestedAt: new Date(now) }).onConflictDoNothing();
    return true;
  }
  async isKnown(address: string): Promise<boolean> {
    const result = await this.db.execute<{ known: boolean }>(sql`select ${known(address)} as known`);
    return result.rows[0]?.known === true;
  }
  /**
   * Deletes up to `EXPIRE_BATCH` jobs nobody has asked for since `cutoff`
   * whose address the product does not follow, and the fills kept for
   * them. Returns the number of jobs removed.
   */
  async expire(now = Date.now(), ttlMs = REQUESTED_JOB_TTL_MS): Promise<number> {
    return this.db.transaction(async tx => {
      const stale = await tx.select({ address: analysisHistoryJobs.address }).from(analysisHistoryJobs)
        .where(and(eq(analysisHistoryJobs.chain, CHAIN_DEFAULT), lt(analysisHistoryJobs.requestedAt, new Date(now - ttlMs)), sql`not ${known(sql`${analysisHistoryJobs.address}`)}`))
        .orderBy(asc(analysisHistoryJobs.requestedAt)).limit(EXPIRE_BATCH).for("update", { skipLocked: true });
      if (stale.length === 0) return 0;
      const addresses = stale.map(r => r.address);
      await tx.delete(analysisHistoryFills).where(and(eq(analysisHistoryFills.chain, CHAIN_DEFAULT), inArray(analysisHistoryFills.address, addresses)));
      await tx.delete(analysisHistoryJobs).where(and(eq(analysisHistoryJobs.chain, CHAIN_DEFAULT), inArray(analysisHistoryJobs.address, addresses)));
      return addresses.length;
    });
  }
  /** Keep fills already fetched by the live analysis path, including
   * records which may expire upstream before the background scan reaches them. */
  async preserve(address: string, batch: HlUserFill[]): Promise<void> {
    const unique = [...new Map(batch.map(f => [f.tid, f])).values()];
    for (let i = 0; i < unique.length; i += 500) {
      await this.db.insert(analysisHistoryFills).values(unique.slice(i, i + 500).map(f => ({
        address, source: f.twapId == null ? "regular" as const : "twap" as const,
        tid: BigInt(f.tid), time: new Date(f.time), raw: f as unknown as Record<string, unknown>,
      }))).onConflictDoNothing();
    }
  }
  /** The span the S3 node archive certifies for this address; null when it
   * has none (not tracked, not ingested yet, or excluded as too heavy). */
  async archiveSpan(address: string): Promise<ArchiveSpan | null> {
    const [row] = await this.db.select().from(archiveCoverage).where(and(
      eq(archiveCoverage.chain, CHAIN_DEFAULT), eq(archiveCoverage.address, address.toLowerCase()), eq(archiveCoverage.status, "active"),
    ));
    return row ? certifiedSpan(row.coveredFrom, row.coveredThrough) : null;
  }
  /** Archive-origin fills inside a certified span, deduplicated by tid
   * (the TWAP row wins, as in `snapshot`). */
  async archivedFills(address: string, span: ArchiveSpan): Promise<HlUserFill[]> {
    const rows = await this.db.select().from(analysisHistoryFills).where(and(
      eq(analysisHistoryFills.chain, CHAIN_DEFAULT), eq(analysisHistoryFills.address, address.toLowerCase()),
      gte(analysisHistoryFills.time, new Date(span.from)), lt(analysisHistoryFills.time, new Date(span.through)),
    )).orderBy(asc(analysisHistoryFills.time), asc(analysisHistoryFills.source));
    const byTid = new Map<number, HlUserFill>();
    for (const row of rows) {
      const fill = row.raw as unknown as HlUserFill;
      if (!byTid.has(fill.tid) || row.source === "twap") byTid.set(fill.tid, fill);
    }
    return [...byTid.values()];
  }
  async state(address: string): Promise<HistoryJob | undefined> {
    return (await this.db.select().from(analysisHistoryJobs).where(mine(address)))[0];
  }
  /** Fair queue with a short claim transaction; no network call holds a DB
   * lock. `preferAttempted`: this turn goes to the least recently attempted
   * job that has run before, if one is due (see the ordering below). */
  async claim(now = Date.now(), preferAttempted = false): Promise<HistoryJob | undefined> {
    return this.db.transaction(async tx => {
      const [job] = await tx.select().from(analysisHistoryJobs).where(and(
        eq(analysisHistoryJobs.chain, CHAIN_DEFAULT), ne(analysisHistoryJobs.status, "blocked"),
        or(isNull(analysisHistoryJobs.attemptedAt), lt(analysisHistoryJobs.attemptedAt, new Date(now - 60_000))),
      // Never-attempted jobs first: plain ASC sorts NULL last, which let the
      // few caught-up jobs (re-eligible every minute) take every turn. But
      // never-attempted first on every turn lets a stream of new jobs
      // starve the ones in progress, so the caller gives every other turn
      // to an attempted job.
      )).orderBy(preferAttempted ? sql`${analysisHistoryJobs.attemptedAt} ASC NULLS LAST` : sql`${analysisHistoryJobs.attemptedAt} ASC NULLS FIRST`).limit(1).for("update", { skipLocked: true });
      if (!job) return undefined;
      return (await tx.update(analysisHistoryJobs).set({ attemptedAt: new Date(now) }).where(mine(job.address)).returning())[0];
    });
  }
  /** CAS prevents a late worker from overwriting a newer checkpoint. Raw
   * data and progress commit atomically; conflicts store neither. */
  async commit(job: HistoryJob, source: HistorySource, batch: HlUserFill[], checkpoint: HistoryCheckpoint): Promise<HistoryJob | undefined> {
    return this.db.transaction(async tx => {
      const status = checkpoint.reason ? "blocked" : completeCheckpoint(checkpoint) ? "caught_up" : "pending";
      const [saved] = await tx.update(analysisHistoryJobs).set({
        checkpoint, version: job.version + 1, status,
        publishedThrough: status === "caught_up" ? new Date(checkpoint.until) : job.publishedThrough,
        lastError: null,
      }).where(and(mine(job.address), eq(analysisHistoryJobs.version, job.version))).returning();
      if (!saved) return undefined;
      const unique = [...new Map(batch.map(f => [f.tid, f])).values()];
      for (let i = 0; i < unique.length; i += 500) {
        await tx.insert(analysisHistoryFills).values(unique.slice(i, i + 500).map(f => ({
          address: job.address, source, tid: BigInt(f.tid), time: new Date(f.time), raw: f as unknown as Record<string, unknown>,
        }))).onConflictDoNothing();
      }
      return saved;
    });
  }
  async failure(job: HistoryJob): Promise<void> {
    // Fixed code: provider error messages can include URLs or infrastructure details.
    await this.db.update(analysisHistoryJobs).set({ lastError: "upstream_unavailable" })
      .where(and(mine(job.address), eq(analysisHistoryJobs.version, job.version)));
  }
  async snapshot(address: string): Promise<HistorySnapshot | null> {
    return this.db.transaction(async tx => {
      const [job] = await tx.select().from(analysisHistoryJobs).where(mine(address));
      if (!job?.publishedThrough) return null;
      const rows = await tx.select().from(analysisHistoryFills).where(and(
        eq(analysisHistoryFills.chain, CHAIN_DEFAULT), eq(analysisHistoryFills.address, address),
        lte(analysisHistoryFills.time, job.publishedThrough),
      )).orderBy(asc(analysisHistoryFills.time), asc(analysisHistoryFills.source));
      // A fill can appear in both endpoints; TWAP carries the extra identity.
      const byTid = new Map<number, HlUserFill>();
      for (const row of rows) {
        const fill = row.raw as unknown as HlUserFill;
        if (!byTid.has(fill.tid) || row.source === "twap") byTid.set(fill.tid, fill);
      }
      return { fills: [...byTid.values()], through: job.publishedThrough };
    }, { isolationLevel: "repeatable read" });
  }
}
