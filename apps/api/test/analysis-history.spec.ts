import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { analysisHistoryFills, analysisHistoryJobs, actions, archiveCoverage, discoveryTraders, kolTraders, leaders, userFavorites } from "@trading-dashboard/shared/database";
import { advanceCheckpoint, initialCheckpoint } from "../src/analytics/history-checkpoint.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { AnalysisHistoryRepository, MAX_REQUESTED_JOBS, REQUESTED_JOB_TTL_MS } from "../src/traders/analysis-history.repository.js";
import { AnalysisHistoryService } from "../src/traders/analysis-history.service.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const ADDRESS = `0x${"ab".repeat(20)}`;
const fill = (tid: number, time = tid): HlUserFill => ({
  tid, time, coin: "BTC", px: "100", sz: "1", side: "B", startPosition: "0", closedPnl: "0",
  dir: "Open Long", hash: "0x1", oid: tid, crossed: true, fee: "0",
});
const batch = (n: number, start = 1) => Array.from({ length: n }, (_, i) => fill(start + i));

describe("durable fill history", () => {
  const db = getTestDb();
  const repository = new AnalysisHistoryRepository(db);
  beforeEach(async () => { await truncateAll(db); });
  afterAll(closeTestDb);
  const provider = (regular: HlUserFill[], twap: HlUserFill[] = []) => ({
    userFillsByTime: async (_: string, start: number, end: number) => regular.filter(f => f.time >= start && f.time <= end).slice(0, 2000),
    userTwapSliceFillsByTime: async (_: string, start: number, end: number) => twap.filter(f => f.time >= start && f.time <= end).slice(0, 2000).map(f => ({ fill: f, twapId: 7 })),
  }) as unknown as HyperliquidInfoClient;

  it("resumes across service restarts beyond 10k fills and six pages", async () => {
    await repository.ensure(ADDRESS, 20000);
    const info = provider(batch(14500), [fill(20000, 15000)]);
    let ticks = 0;
    while ((await repository.state(ADDRESS))!.status !== "caught_up") {
      const restarted = new AnalysisHistoryService(new AnalysisHistoryRepository(db), info);
      await restarted.advance((await repository.state(ADDRESS))!, 20000);
      expect(++ticks).toBeLessThan(15);
    }
    const snapshot = (await repository.snapshot(ADDRESS))!;
    expect(snapshot.fills).toHaveLength(14501);
    expect(snapshot.through.getTime()).toBe(20000);
    expect(snapshot.fills.find(f => f.tid === 20000)?.twapId).toBe(7);
    expect(await db.select().from(actions)).toHaveLength(0);
  });

  it("does not publish until both sources complete the same fixed cutoff", async () => {
    await repository.ensure(ADDRESS, 10000);
    const service = new AnalysisHistoryService(repository, provider(batch(4001), batch(4001, 5000)));
    await service.advance((await repository.state(ADDRESS))!, 20000);
    expect(await repository.snapshot(ADDRESS)).toBeNull();
    expect((await repository.state(ADDRESS))!.checkpoint.until).toBe(10000);
    for (let i = 0; i < 4; i++) {
      const job = (await repository.state(ADDRESS))!;
      if (job.status === "caught_up") break;
      await service.advance(job, 20000);
    }
    expect((await repository.snapshot(ADDRESS))!.through.getTime()).toBe(10000);
  });

  it("retains the previous snapshot during a long forward catch-up", async () => {
    const rows = batch(10);
    const service = new AnalysisHistoryService(repository, provider(rows));
    await repository.ensure(ADDRESS, 20);
    await service.advance((await repository.state(ADDRESS))!, 20);
    rows.push(...batch(14500, 30));
    await service.advance((await repository.state(ADDRESS))!, 20000);
    expect((await repository.snapshot(ADDRESS))!.through.getTime()).toBe(20);
    for (let i = 0; i < 10 && (await repository.state(ADDRESS))!.status !== "caught_up"; i++) {
      await new AnalysisHistoryService(repository, provider(rows)).advance((await repository.state(ADDRESS))!, 30000);
    }
    const snapshot = (await repository.snapshot(ADDRESS))!;
    expect(snapshot.through.getTime()).toBe(20000);
    expect(snapshot.fills).toHaveLength(14510);
  });

  it("blocks a saturated millisecond without skipping it", async () => {
    await repository.ensure(ADDRESS, 10000);
    const service = new AnalysisHistoryService(repository, provider(batch(2100).map(f => ({ ...f, time: 100 }))));
    for (let i = 0; i < 2; i++) await service.advance((await repository.state(ADDRESS))!);
    const job = (await repository.state(ADDRESS))!;
    expect(job.status).toBe("blocked");
    expect(job.checkpoint.sources.regular.cursor).toBe(100);
    expect(job.checkpoint.reason).toBe("timestamp_saturated");
    expect(await repository.snapshot(ADDRESS)).toBeNull();
    expect(await repository.claim()).toBeUndefined();
  });

  it("retries a failed source without losing the other source's commit", async () => {
    await repository.ensure(ADDRESS, 100);
    const info = provider(batch(2));
    info.userTwapSliceFillsByTime = async () => { throw new Error("unavailable"); };
    await expect(new AnalysisHistoryService(repository, info).advance((await repository.state(ADDRESS))!)).rejects.toThrow();
    expect((await repository.state(ADDRESS))!.checkpoint.sources.regular.status).toBe("complete");
    await new AnalysisHistoryService(repository, provider(batch(2))).advance((await repository.state(ADDRESS))!);
    expect((await repository.snapshot(ADDRESS))!.fills).toHaveLength(2);
  });

  it("rolls back the cursor if the raw insert fails", async () => {
    await repository.ensure(ADDRESS, 100);
    const job = (await repository.state(ADDRESS))!;
    const next = advanceCheckpoint(job.checkpoint, "regular", [fill(1)]);
    await expect(repository.commit(job, "regular", [fill(NaN)], next)).rejects.toThrow();
    expect((await repository.state(ADDRESS))!.version).toBe(0);
    expect(await db.select().from(analysisHistoryFills)).toHaveLength(0);
  });

  it("rejects stale worker commits and deduplicates overlap with TWAP metadata", async () => {
    await repository.ensure(ADDRESS, 100);
    const original = (await repository.state(ADDRESS))!;
    const next = advanceCheckpoint(original.checkpoint, "regular", [fill(1)]);
    const saved = (await repository.commit(original, "regular", [fill(1)], next))!;
    expect(await repository.commit(original, "regular", [fill(2)], next)).toBeUndefined();
    await repository.commit(saved, "twap", [{ ...fill(1), twapId: 7 }], advanceCheckpoint(saved.checkpoint, "twap", [fill(1)]));
    const snapshot = (await repository.snapshot(ADDRESS))!;
    expect(snapshot.fills).toHaveLength(1);
    expect(snapshot.fills[0].twapId).toBe(7);
  });

  it("keeps locally collected fills after upstream retention expires", async () => {
    await repository.ensure(ADDRESS, 100);
    await repository.preserve(ADDRESS, [fill(1)]);
    await new AnalysisHistoryService(repository, provider([fill(2)])).advance((await repository.state(ADDRESS))!);
    expect((await repository.snapshot(ADDRESS))!.fills.map(f => f.tid)).toEqual([1, 2]);
  });

  it("claims distinct eligible addresses and excludes recently attempted ones", async () => {
    await repository.ensure(ADDRESS);
    await repository.ensure(`0x${"cd".repeat(20)}`);
    const jobs = await Promise.all([repository.claim(), repository.claim()]);
    expect(new Set(jobs.map(j => j!.address)).size).toBe(2);
    expect(await repository.claim()).toBeUndefined();
    await db.update(analysisHistoryJobs).set({ attemptedAt: new Date(0) }).where(eq(analysisHistoryJobs.address, ADDRESS));
    expect((await repository.claim())!.address).toBe(ADDRESS);
  });

  describe("admission, the cap, expiry and the queue's share (review 27)", () => {
    const other = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    const jobs = async () => (await db.select().from(analysisHistoryJobs)).map(j => j.address).sort();

    it("an anonymous caller gets a job only for an address the product follows: pool, KOL, watched, favorited or archived", async () => {
      expect(await repository.ensure(ADDRESS, Date.now(), 0, "anonymous")).toBe(false);
      expect(await jobs()).toEqual([]);

      const [pool, kol, watched, inactive, favorite, archived] = [1, 2, 3, 4, 5, 6].map(other);
      const user = await insertUser(db);
      await db.insert(discoveryTraders).values({ address: pool });
      await db.insert(kolTraders).values({ address: kol });
      await db.insert(leaders).values([{ address: watched, active: true }, { address: inactive, active: false }]);
      await db.insert(userFavorites).values({ userId: user.id, address: favorite });
      await db.insert(archiveCoverage).values({ address: archived });
      for (const address of [pool, kol, watched, favorite, archived]) expect(await repository.ensure(address, Date.now(), 0, "anonymous"), address).toBe(true);
      expect(await repository.ensure(inactive, Date.now(), 0, "anonymous")).toBe(false);
      expect(await jobs()).toEqual([pool, kol, watched, favorite, archived].sort());
      // A job that exists is used by anyone, and counts as asked for again.
      await db.delete(discoveryTraders);
      expect(await repository.ensure(pool, Date.now() + 5_000, 0, "anonymous")).toBe(true);
    });

    it("a signed-in caller may add other addresses, up to the cap on pending ones; the product's own jobs are never capped", async () => {
      await db.insert(analysisHistoryJobs).values(Array.from({ length: MAX_REQUESTED_JOBS - 1 }, (_, i) => ({ address: other(1_000 + i), checkpoint: initialCheckpoint(Date.now(), 0) })));
      expect(await repository.ensure(other(1), Date.now(), 0, "user")).toBe(true);
      expect(await repository.ensure(other(2), Date.now(), 0, "user")).toBe(false);
      expect(await repository.ensure(other(3), Date.now(), 0, "product")).toBe(true);
      // Finished jobs free their place.
      await db.update(analysisHistoryJobs).set({ status: "caught_up" }).where(eq(analysisHistoryJobs.address, other(1)));
      await db.update(analysisHistoryJobs).set({ status: "caught_up" }).where(eq(analysisHistoryJobs.address, other(3)));
      expect(await repository.ensure(other(2), Date.now(), 0, "user")).toBe(true);
    });

    it("a job nobody asked for in 14 days is deleted with its fills, unless the product follows the address", async () => {
      const [forgotten, followed, recent] = [1, 2, 3].map(other);
      const old = Date.now() - REQUESTED_JOB_TTL_MS - 60_000;
      for (const address of [forgotten, followed]) {
        await repository.ensure(address, old);
        await repository.preserve(address, [fill(1), fill(2)]);
      }
      await repository.ensure(recent, Date.now() - 3_600_000);
      await repository.preserve(recent, [fill(3)]);
      await db.insert(kolTraders).values({ address: followed });

      expect(await repository.expire()).toBe(1);
      expect(await jobs()).toEqual([followed, recent].sort());
      const kept = await db.select().from(analysisHistoryFills);
      expect(kept.map(f => f.address).sort()).toEqual([followed, followed, recent].sort());
      expect(await repository.expire()).toBe(0);
    });

    it("every other turn goes to a job already in progress, so new jobs can't hold the whole queue", async () => {
      const [running, fresh1, fresh2] = [1, 2, 3].map(other);
      for (const address of [running, fresh1, fresh2]) await repository.ensure(address);
      await db.update(analysisHistoryJobs).set({ attemptedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(analysisHistoryJobs.address, running));
      const service = new AnalysisHistoryService(repository, provider([]));
      const attempted = async () => (await db.select().from(analysisHistoryJobs)).filter(j => j.attemptedAt && Date.now() - j.attemptedAt.getTime() < 30_000).map(j => j.address);
      await service.tick(); // a new job
      expect(await attempted()).toHaveLength(1);
      expect(await attempted()).not.toContain(running);
      await service.tick(); // the job in progress, although a never-attempted one is still waiting
      expect(await attempted()).toContain(running);
      expect(await attempted()).toHaveLength(2);
      // With no attempted job due, that turn falls to a new one instead of being wasted.
      expect((await repository.claim(Date.now(), true))!.attemptedAt).not.toBeNull();
      expect(await attempted()).toHaveLength(3);
    });
  });
});

it("rejects out-of-range/future data without advancing a checkpoint", () => {
  const checkpoint = initialCheckpoint(100);
  expect(() => advanceCheckpoint(checkpoint, "regular", [fill(1, 101)])).toThrow("bounds");
  expect(checkpoint.sources.regular.cursor).toBe(0);
});
