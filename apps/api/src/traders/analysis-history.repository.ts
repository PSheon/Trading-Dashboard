import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, lt, lte, ne, or } from "drizzle-orm";
import { analysisHistoryFills, analysisHistoryJobs } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { completeCheckpoint, initialCheckpoint, type HistoryCheckpoint, type HistorySource } from "../analytics/history-checkpoint.js";

export type HistoryJob = typeof analysisHistoryJobs.$inferSelect;
export interface HistorySnapshot { fills: HlUserFill[]; through: Date }
const mine = (address: string) => and(eq(analysisHistoryJobs.chain, CHAIN_DEFAULT), eq(analysisHistoryJobs.address, address));

@Injectable()
export class AnalysisHistoryRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async ensure(address: string, now = Date.now()): Promise<void> {
    await this.db.insert(analysisHistoryJobs).values({ address, checkpoint: initialCheckpoint(now) }).onConflictDoNothing();
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
  async state(address: string): Promise<HistoryJob | undefined> {
    return (await this.db.select().from(analysisHistoryJobs).where(mine(address)))[0];
  }
  /** Fair queue with a short claim transaction; no network call holds a DB lock. */
  async claim(now = Date.now()): Promise<HistoryJob | undefined> {
    return this.db.transaction(async tx => {
      const [job] = await tx.select().from(analysisHistoryJobs).where(and(
        eq(analysisHistoryJobs.chain, CHAIN_DEFAULT), ne(analysisHistoryJobs.status, "blocked"),
        or(isNull(analysisHistoryJobs.attemptedAt), lt(analysisHistoryJobs.attemptedAt, new Date(now - 60_000))),
      )).orderBy(asc(analysisHistoryJobs.attemptedAt)).limit(1).for("update", { skipLocked: true });
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
