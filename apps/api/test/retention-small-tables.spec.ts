import { RETENTION_DEFAULTS } from "@trading-dashboard/shared/contracts";
import {
  cohortSnapshots, copyEquitySnapshots, copyExecutionAccounts, copyFollowerObservationJobs, copyFollowerObservations, copyStrategies,
} from "@trading-dashboard/shared/database";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/app-config.js";
import { COPY_EQUITY_FULL_RESOLUTION_MS } from "../src/config/constants/cache-ttls.js";
import { TUNING_DEFAULTS, validateEnvironment } from "../src/config/runtime-config.js";
import { CopyPerformanceService } from "../src/copy/copy-performance.service.js";
import { CopyRepository } from "../src/copy/copy.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { CohortRepository } from "../src/insights/cohort.repository.js";
import { RetentionRepository } from "../src/retention/retention.repository.js";
import { RetentionService, retentionCutoffs } from "../src/retention/retention.service.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

/**
 * Retention of the small tables that had none (cost reduction 2026-10-22, §1 #9):
 * a paper copy's per-minute valuations are thinned once its charts' fixed windows no
 * longer reach them, old cohort history rows lose their unread member lists, and a live
 * account's superseded follower observations go. What each reader needs stays.
 */
const db = getTestDb();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** A minute boundary in the past. The performance reads take "now" from the clock: Date is
 * held at NOW + 1 min in the copy tests, and valuations run 10 min past it, so the SQL clock
 * (sparklines) finds a fresh one too. */
const NOW = new Date(Math.floor(Date.now() / MIN) * MIN);
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const LEADER = `0x${"a1".repeat(20)}`;

function retention() {
  const config = { value: { tuning: { ...TUNING_DEFAULTS } } } as unknown as AppConfig;
  const settings = new SettingsService(new SettingsRepository(db), new UnitOfWork(db), undefined, config);
  const service = new RetentionService(new RetentionRepository(db), settings, new UnitOfWork(db), new BackgroundJobs());
  service.limits = { ...service.limits, pauseMs: 0 };
  return service;
}
async function run() {
  const result = await retention().run(NOW, true);
  if (!result.ran) throw new Error("did not run");
  expect(result).toMatchObject({ status: "ok", error: null });
  return result.removed;
}

beforeEach(() => truncateAll(db));
afterAll(closeTestDb);

describe("retention of the small tables", () => {
  it("has its periods: 31 days of full resolution (not less), 30 days of member lists, 7 days of superseded observations", () => {
    expect(RETENTION_DEFAULTS).toMatchObject({ copyEquityFullDays: 31, cohortMemberListDays: 30, followerObservationDays: 7 });
    expect(COPY_EQUITY_FULL_RESOLUTION_MS).toBe(31 * DAY);
    const cut = retentionCutoffs(RETENTION_DEFAULTS, NOW);
    expect([cut.copy_equity_snapshots, cut.cohort_snapshot_members, cut.copy_follower_observations]).toEqual([ago(31 * DAY), ago(30 * DAY), ago(7 * DAY)]);
    const env = (extra: Record<string, string>) => () => validateEnvironment({ DATABASE_URL: "postgres://u@localhost/db", ...extra });
    expect(env({ RETENTION_COPY_EQUITY_FULL_DAYS: "30" })).toThrow("RETENTION_COPY_EQUITY_FULL_DAYS must be an integer between 31 and 3650");
    expect(env({ RETENTION_COHORT_MEMBER_LIST_DAYS: "6" })).toThrow("RETENTION_COHORT_MEMBER_LIST_DAYS must be an integer between 7 and 3650");
    expect(env({ RETENTION_FOLLOWER_OBSERVATION_DAYS: "0" })).toThrow("RETENTION_FOLLOWER_OBSERVATION_DAYS must be an integer between 1 and 3650");
    expect(env({ RETENTION_COPY_EQUITY_FULL_DAYS: "60", RETENTION_FOLLOWER_OBSERVATION_DAYS: "2" })().tuning.retention)
      .toMatchObject({ copyEquityFullDays: 60, followerObservationDays: 2 });
  });

  describe("copy_equity_snapshots: a paper copy's valuations are thinned where only its whole-life views read them", () => {
    async function copy(userId: number, createdAt: Date, o: { stoppedAt?: Date; mode?: "paper" | "testnet"; leader?: string } = {}) {
      const [row] = await db.insert(copyStrategies).values({ userId, leaderAddress: o.leader ?? LEADER, mode: o.mode ?? "paper", network: "testnet",
        allocated: o.mode === "testnet" ? "0" : "1000", cash: o.stoppedAt || o.mode === "testnet" ? "0" : "1000", status: o.stoppedAt ? "stopped" : "active", activatedAt: createdAt, createdAt,
        stoppedAt: o.stoppedAt ?? null }).returning({ id: copyStrategies.id });
      return row!.id;
    }
    /** One valuation a minute from `from` through `to`, PnL one per hour. */
    async function minutely(strategyId: number, from: Date, to: Date) {
      const rows = [];
      for (let t = from.getTime(); t <= to.getTime(); t += MIN) {
        const pnl = String(Math.round(((t - from.getTime()) / HOUR) * 1e6) / 1e6);
        rows.push({ strategyId, time: new Date(t), equity: String(1000 + Number(pnl)), totalPnl: pnl, netDeposits: "1000", exposureUsd: "0" });
      }
      for (let i = 0; i < rows.length; i += 2000) await db.insert(copyEquitySnapshots).values(rows.slice(i, i + 2000));
      return rows.length;
    }
    const times = async (strategyId: number) => (await db.select({ time: copyEquitySnapshots.time }).from(copyEquitySnapshots)
      .where(eq(copyEquitySnapshots.strategyId, strategyId)).orderBy(asc(copyEquitySnapshots.time))).map((r) => r.time.getTime());
    const performance = () => new CopyPerformanceService(new CopyRepository(db), new UnitOfWork(db), {} as never, {} as never);
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW.getTime() + MIN }); });
    afterEach(() => { vi.useRealTimers(); });

    it("keeps each old hour's first and last valuation, every valuation of the last 31 days, and every chart", async () => {
      const owner = (await insertUser(db)).id;
      // Running for 32 days: its first day is older than the horizon.
      const running = await copy(owner, ago(32 * DAY));
      await minutely(running, ago(32 * DAY), new Date(NOW.getTime() + 10 * MIN));
      // Stopped two days ago after 33 days: its horizon is 31 days before its stop.
      const stopAt = ago(2 * DAY);
      const stopped = await copy(owner, ago(35 * DAY), { stoppedAt: stopAt, leader: `0x${"b2".repeat(20)}` });
      await minutely(stopped, ago(35 * DAY), stopAt);
      // A live copy's valuations are never thinned.
      const live = await copy(owner, ago(40 * DAY), { mode: "testnet", leader: `0x${"c3".repeat(20)}` });
      await minutely(live, ago(40 * DAY), ago(40 * DAY - 3 * HOUR));

      const service = performance();
      const views = async () => ({
        all: await service.history(owner, running, { window: "all" }), d30: await service.history(owner, running, { window: "30d" }),
        d7: await service.history(owner, running, { window: "7d" }), d1: await service.history(owner, running, { window: "1d" }),
        stoppedAll: await service.history(owner, stopped, { window: "all" }), stopped30: await service.history(owner, stopped, { window: "30d" }),
        portfolioAll: await service.portfolio(owner, { window: "all" }, NOW), portfolio30: await service.portfolio(owner, { window: "30d" }, NOW),
      });
      const before = await views();
      expect(before.all.coverage.complete).toBe(true);
      expect(before.portfolioAll.sparklines.every((s) => s.points.every((p) => p !== null))).toBe(true);
      const beforeTimes = { running: await times(running), stopped: await times(stopped), live: await times(live) };

      const removed = await run();
      const after = { running: await times(running), stopped: await times(stopped), live: await times(live) };
      expect(after.live).toEqual(beforeTimes.live);
      const horizon = (end: number) => Math.floor((end - COPY_EQUITY_FULL_RESOLUTION_MS) / HOUR) * HOUR;
      for (const [name, end] of [["running", NOW.getTime()], ["stopped", stopAt.getTime()]] as const) {
        const cut = horizon(end);
        const kept = after[name], old = beforeTimes[name].filter((t) => t < cut);
        // Before the horizon: exactly the first and last valuation of each UTC hour.
        const hours = new Map<number, number[]>();
        for (const t of old) hours.set(Math.floor(t / HOUR), [...(hours.get(Math.floor(t / HOUR)) ?? []), t]);
        const expected = [...hours.values()].flatMap((ts) => [...new Set([ts[0]!, ts.at(-1)!])]);
        expect(kept.filter((t) => t < cut), name).toEqual(expected);
        // From the horizon on: every valuation.
        expect(kept.filter((t) => t >= cut), name).toEqual(beforeTimes[name].filter((t) => t >= cut));
      }
      expect(removed.copy_equity_snapshots).toBe(beforeTimes.running.length + beforeTimes.stopped.length - after.running.length - after.stopped.length);
      expect(removed.copy_equity_snapshots).toBeGreaterThan(24 * 56);

      const thinned = await views();
      // The fixed windows read no thinned row: the same answer to the value.
      for (const key of ["d30", "d7", "d1", "stopped30"] as const) expect(thinned[key], key).toEqual(before[key]);
      // (A portfolio answer also carries each copy's whole-life sparkline: below.)
      const series = ({ points, partial, todayPnl }: typeof before.portfolio30) => ({ points, partial, todayPnl });
      expect(series(thinned.portfolio30)).toEqual(series(before.portfolio30));
      // The whole-life views keep their first and last valuation, every point priced, no hole.
      for (const key of ["all", "stoppedAll"] as const) {
        expect(thinned[key].coverage, key).toEqual(before[key].coverage);
        expect(thinned[key].points.every((p) => p.equity !== null && p.totalPnl !== null), key).toBe(true);
        expect(thinned[key].todayPnl, key).toEqual(before[key].todayPnl);
      }
      expect(thinned.portfolioAll.partial).toBe(false);
      expect(thinned.portfolioAll.points.at(-1)).toEqual(before.portfolioAll.points.at(-1));
      expect(thinned.portfolioAll.sparklines.every((s) => s.points.every((p) => p !== null))).toBe(true);
      expect(thinned.portfolioAll.todayPnl).toEqual(before.portfolioAll.todayPnl);

      // A second run finds nothing more to thin.
      expect((await run()).copy_equity_snapshots).toBe(0);
    }, 120_000);

    it("a real hole in a thinned stretch is still shown as missing", async () => {
      const owner = (await insertUser(db)).id;
      const id = await copy(owner, ago(33 * DAY));
      // Two hours of nothing, 32.5 days ago.
      await minutely(id, ago(33 * DAY), ago(32.5 * DAY));
      await minutely(id, ago(32.5 * DAY - 2 * HOUR), new Date(NOW.getTime() + 10 * MIN));
      await run();
      const all = await performance().history(owner, id, { window: "all" });
      expect(all.coverage.complete).toBe(false);
      expect(all.points.some((p) => p.equity === null)).toBe(true);
    }, 120_000);
  });

  it("cohort_snapshots: member lists older than 30 days are cleared; the rows, their figures and membership stay", async () => {
    const snapshot = (days: number) => ({ tier: "extremely_profitable", ts: ago(days * DAY), membershipVersion: "f".repeat(64), memberAddresses: [LEADER],
      memberCount: 1, walletCount: 1, notionalLong: "1", notionalShort: "1", longPct: "50", upnlProfit: "0", upnlLoss: "0", walletsInProfit: 0, walletsInLoss: 0 });
    await db.insert(cohortSnapshots).values([40, 31, 29, 1].map(snapshot));
    const history = () => new CohortRepository(db).history("extremely_profitable", null);
    const before = await history();
    expect((await run()).cohort_snapshot_members).toBe(2);
    const rows = await db.select().from(cohortSnapshots).orderBy(asc(cohortSnapshots.ts));
    expect(rows.map((r) => r.memberAddresses)).toEqual([null, null, [LEADER], [LEADER]]);
    expect(rows.every((r) => r.membershipVersion === "f".repeat(64))).toBe(true);
    expect(await history()).toEqual(before);
    expect((await run()).cohort_snapshot_members).toBe(0);
  });

  it("copy_follower_observations: superseded ones older than 7 days go; an account's latest never does, however old", async () => {
    const owner = (await insertUser(db)).id;
    const strategies = await db.insert(copyStrategies).values([1, 2].map((n) => ({ userId: owner, leaderAddress: `0x${String(n + 4).repeat(40)}`, mode: "testnet" as const,
      network: "testnet" as const, allocated: "0", cash: "0", status: "active" as const, activatedAt: ago(30 * DAY) }))).returning({ id: copyStrategies.id });
    const strategyOf = (n: number) => strategies[n - 1]!.id;
    const account = (n: number) => ({ id: `account-${n}`, userId: owner, strategyId: strategyOf(n), network: "testnet" as const, privyUserId: "did:privy:o",
      externalId: `master-${n}`, state: "ready" as const, address: `0x${String(n).repeat(40)}`, privyWalletId: `wallet-${n}`, ownerQuorumId: "owner" });
    await db.insert(copyExecutionAccounts).values([account(1), account(2)]);
    let digest = 0;
    const observation = (n: number, days: number) => {
      const at = ago(days * DAY);
      return { id: `obs-${n}-${days}`, accountId: `account-${n}`, userId: owner, strategyId: strategyOf(n), network: "testnet" as const,
        accountAddress: `0x${String(n).repeat(40)}`, sourceDigest: (++digest).toString(16).padStart(64, "0"), observedAt: at,
        completedAt: new Date(at.getTime() + 1000), earliestProviderTime: at, snapshot: {} };
    };
    // Account 1: latest 1 day old. Account 2: every observation old, its latest 20 days old.
    await db.insert(copyFollowerObservations).values([observation(1, 30), observation(1, 8), observation(1, 6), observation(1, 1),
      observation(2, 40), observation(2, 20)]);
    await db.insert(copyFollowerObservationJobs).values([{ accountId: "account-1", latestObservationId: "obs-1-1" }, { accountId: "account-2", latestObservationId: "obs-2-20" }]);

    expect((await run()).copy_follower_observations).toBe(3);
    expect((await db.select({ id: copyFollowerObservations.id }).from(copyFollowerObservations)).map((r) => r.id).sort()).toEqual(["obs-1-1", "obs-1-6", "obs-2-20"]);
    // An observation another job points at (any account's) is spared too.
    await db.insert(copyFollowerObservations).values(observation(1, 9));
    await db.update(copyFollowerObservationJobs).set({ latestObservationId: "obs-1-9" }).where(eq(copyFollowerObservationJobs.accountId, "account-2"));
    expect((await run()).copy_follower_observations).toBe(1);
    expect((await db.select({ id: copyFollowerObservations.id }).from(copyFollowerObservations)).map((r) => r.id).sort()).toEqual(["obs-1-1", "obs-1-6", "obs-1-9"]);
  });
});
