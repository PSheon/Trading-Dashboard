import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { actions, archiveCoverage, cohortMembers, discoveryTraders, kolTraders, leaders, userFavorites } from "@trading-dashboard/shared/database";

import { auditFills, reconcileFills } from "../src/analytics/fill-integrity.js";
import { ARCHIVE_BOUNDARY_MARGIN_MS } from "../src/analytics/history-checkpoint.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { archiveKey, HOUR_MS } from "../src/ingest/archive-format.js";
import { ArchiveIngestRepository } from "../src/ingest/archive-ingest.repository.js";
import { ArchiveIngestService } from "../src/ingest/archive-ingest.service.js";
import { LocalArchiveStore, type ArchiveStore } from "../src/ingest/archive-store.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";
import { AnalysisHistoryRepository } from "../src/traders/analysis-history.repository.js";
import { AnalysisHistoryService } from "../src/traders/analysis-history.service.js";
import { storedFrame } from "./archive-test-utils.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, insertUser, storedFills, truncateAll } from "./db-test-utils.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/archive/", import.meta.url));
const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as Record<string, HlUserFill[]>;
const ADDRESSES = Object.keys(expected);
const TOTAL = Object.values(expected).reduce((sum, fills) => sum + fills.length, 0);
const H11 = Date.UTC(2026, 8, 25, 11);
const H12 = H11 + HOUR_MS;
const H13 = H12 + HOUR_MS;
/** 13:30: hour 12 has settled (20 min), hour 13 has not ended. */
const NOW = H13 + 30 * 60_000;
const size = (hour: number) => statSync(join(FIXTURES, archiveKey(hour))).size;

function config(overrides: Partial<AppConfig["value"]["archive"]> = {}): AppConfig {
  const base = testConfig().value;
  return { value: { ...base, archive: { ...base.archive, enabled: true, localDir: FIXTURES, start: H11, ...overrides } } } as AppConfig;
}

describe("archive ingest", () => {
  const db = getTestDb();
  const repository = new ArchiveIngestRepository(db);
  const history = new AnalysisHistoryRepository(db);
  const temp: string[] = [];
  const service = (overrides: Partial<AppConfig["value"]["archive"]> = {}, store: ArchiveStore = new LocalArchiveStore(overrides.localDir ?? FIXTURES)) =>
    new ArchiveIngestService(config(overrides), repository, new BackgroundJobs(), store);
  const track = (addresses: string[]) => db.insert(kolTraders).values(addresses.map((address) => ({ address }))).onConflictDoNothing();
  const stored = async (address: string) => (await storedFills(db, address)).map((row) => row.fill);
  const count = async () => Number((await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM history_fills`)).rows[0].n);
  const span = async (address: string) => {
    const [row] = await db.select().from(archiveCoverage).where(eq(archiveCoverage.address, address));
    return row ? [row.coveredFrom?.getTime() ?? null, row.coveredThrough?.getTime() ?? null, row.status] : undefined;
  };

  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => {
    for (const dir of temp) rmSync(dir, { recursive: true, force: true });
    await closeTestDb();
  });

  it("the tracked set is one query: pool, KOLs, favorites, cohorts, leaders and live copy leaders", async () => {
    const a = (n: number) => `0x${String(n).padStart(40, "0")}`;
    const user = await insertUser(db);
    await db.insert(discoveryTraders).values([{ address: a(1) }, { address: a(2), inPool: false }]);
    await db.insert(kolTraders).values([{ address: a(3) }, { address: a(1) }]);
    await db.insert(userFavorites).values({ userId: user.id, address: a(4) });
    await db.insert(cohortMembers).values({ address: a(5), tier: "profitable", source: "pool", rank: 1 });
    await db.insert(leaders).values([{ address: a(6) }, { address: a(7), active: false }, { address: `0x${"AB".repeat(20)}` }]);
    for (const [address, status] of [[a(8), "active"], [a(9), "stopped"], [a(10), "paused"]]) {
      await db.execute(sql`INSERT INTO copy_strategies (user_id, leader_address, status, allocated, cash, activated_at, stopped_at) VALUES (${user.id}, ${address}, ${status}, 100, 100, now(), ${status === "stopped" ? new Date() : null})`);
    }
    expect(await repository.trackedSet()).toEqual([a(1), a(3), a(4), a(5), a(6), a(8), a(10), `0x${"ab".repeat(20)}`]);
    expect(await repository.syncTrackedSet()).toBe(8);
    // Idempotent; an explicit admission of a known address adds nothing.
    await repository.enqueue([a(1).toUpperCase().replace("0X", "0x"), a(11)]);
    expect(await repository.syncTrackedSet()).toBe(0);
    expect((await repository.coverageCounts(H11)).total).toBe(9);
  });

  it("end to end: live hour, then backfill to the archive's first hour; stored fills equal REST's, tid by tid", async () => {
    await track(ADDRESSES);
    const ingest = service();
    expect(await ingest.tick(NOW)).toEqual(["ingested", "ingested"]);
    expect(await count()).toBe(TOTAL);
    for (const address of ADDRESSES) {
      const fills = await stored(address);
      expect(reconcileFills(fills, expected[address]), address).toMatchObject({ exact: true, onlyLeft: [], onlyRight: [], mismatches: [] });
      const audit = auditFills(address, fills);
      expect([audit.duplicateTids, audit.positionBreaks, audit.pnl.holds], address).toEqual([[], [], true]);
      expect(await span(address)).toEqual([H11, H13, "active"]);
      expect(await history.archiveSpan(address)).toEqual({ from: H11 + ARCHIVE_BOUNDARY_MARGIN_MS, through: H13 - ARCHIVE_BOUNDARY_MARGIN_MS });
    }
    const rows = await storedFills(db);
    expect(new Set(rows.map((row) => row.origin))).toEqual(new Set(["s3"]));
    expect(rows.filter((row) => row.source === "twap")).toHaveLength(48);
    // Historical ingestion never creates watcher actions (no alerts).
    expect(await db.select().from(actions)).toHaveLength(0);

    const status = await ingest.status(NOW);
    expect(status).toMatchObject({
      enabled: true, liveNextHour: new Date(H13), backfillCursorHour: null, lagSeconds: 1800, objects: 2,
      bytes: size(H11) + size(H12), fillsSeen: TOTAL * 2, fillsKept: TOTAL, spendDayBytes: size(H11) + size(H12),
      addresses: { total: ADDRESSES.length, backfilled: ADDRESSES.length, pending: 0, excluded: 0 }, lastError: null,
    });
    expect(status.spendDayUsd).toBeCloseTo(((size(H11) + size(H12)) / 1e9) * 0.114, 4);
    // Nothing left to do: no object is read twice.
    expect(await ingest.tick(NOW)).toEqual([]);
    expect((await ingest.status(NOW)).objects).toBe(2);
  });

  it("resumes at the stored cursor after a crash mid-object, without duplicates", async () => {
    await track(ADDRESSES);
    const local = new LocalArchiveStore(FIXTURES);
    let opened = 0;
    const crashing: ArchiveStore = {
      open: async (key) => {
        const object = (await local.open(key))!;
        if (++opened < 2) return object;
        // The second object's download dies half way through.
        return { ...object, body: (async function* () {
          let sent = 0;
          for await (const chunk of object.body) {
            if (sent > object.size / 2) throw new Error("socket closed");
            sent += chunk.length;
            yield chunk;
          }
        })() };
      },
    };
    await expect(service({}, crashing).tick(NOW)).rejects.toThrow();
    const state = await repository.state();
    expect([state.liveNextHour?.getTime(), state.backfillCursorHour?.getTime(), state.objects]).toEqual([H13, H11, 1]);
    expect(await span(ADDRESSES[0])).toEqual([H12, H13, "active"]);
    const partial = await count();
    expect(partial).toBeLessThan(TOTAL);

    // A new process: same database, fresh service.
    expect(await service().tick(NOW)).toEqual(["ingested"]);
    expect(await count()).toBe(TOTAL);
    expect(await span(ADDRESSES[0])).toEqual([H11, H13, "active"]);
    expect((await repository.state()).objects).toBe(2);
  });

  it("a stale worker's commit is rejected by the state version", async () => {
    await track(ADDRESSES);
    await repository.syncTrackedSet();
    const state = await repository.state();
    const moved = await repository.moveCursor(state, { liveNextHour: new Date(H12) });
    expect(moved?.version).toBe(state.version + 1);
    expect(await repository.moveCursor(state, { liveNextHour: new Date(H11) })).toBeUndefined();
    const { snapshotAt } = await repository.participants("live", H12);
    const commit = { direction: "live" as const, hour: H12, key: "k", bytes: 1, fillsSeen: 0, fillsKept: 0, snapshotAt, excluded: [], floor: H11, day: "2026-09-25" };
    expect(await repository.commitObject(state, commit)).toBeUndefined();
    expect(await span(ADDRESSES[0])).toEqual([null, null, "active"]);
    expect(await repository.commitObject(moved!, commit)).toBeDefined();
    expect(await span(ADDRESSES[0])).toEqual([H12, H13, "active"]);
  });

  it("deduplicates against fills REST already stored, keeping one row per tid", async () => {
    const address = ADDRESSES[0];
    await track([address]);
    const fromRest = expected[address].slice(0, 120);
    await history.preserve(address, fromRest);
    await service().tick(NOW);
    const rows = await storedFills(db, address);
    expect(rows).toHaveLength(expected[address].length);
    expect(new Set(rows.map((row) => row.tid)).size).toBe(rows.length);
    expect(rows.filter((row) => row.origin === "rest")).toHaveLength(120);
    expect(reconcileFills(rows.map((row) => row.fill), expected[address]).exact).toBe(true);
  });

  it("stops before the daily spend cap and says so", async () => {
    await track(ADDRESSES);
    const usdPerGb = 0.114;
    const maxDailyUsd = ((size(H11) + 10) / 1e9) * usdPerGb; // room for one object a day
    const ingest = service({ maxDailyUsd, usdPerGb });
    expect(await ingest.tick(NOW)).toEqual(["ingested", "over_budget"]);
    const status = await ingest.status(NOW);
    expect([status.objects, status.spendDayBytes, status.lastError]).toEqual([1, size(H12), "daily_budget_reached"]);
    expect(status.backfillCursorHour).toEqual(new Date(H11));
    // The next UTC day has its own allowance.
    expect(await ingest.tick(NOW + 24 * HOUR_MS)).toContain("ingested");
    expect(await span(ADDRESSES[0])).toEqual([H11, H13, "active"]);
  });

  it("paces by bytes per run", async () => {
    await track(ADDRESSES);
    const ingest = service({ maxBytesPerMinute: 1 });
    expect(await ingest.tick(NOW)).toEqual(["ingested"]);
    expect(await ingest.tick(NOW)).toEqual(["ingested"]);
    expect(await count()).toBe(TOTAL);
  });

  it("an address that joins later starts at the next live hour and is backfilled by a new pass", async () => {
    const [early, late] = [ADDRESSES[0], ADDRESSES[1]];
    const dir = mkdtempSync(join(tmpdir(), "archive-"));
    temp.push(dir);
    cpSync(join(FIXTURES, "node_fills_by_block"), join(dir, "node_fills_by_block"), { recursive: true });
    const lateFill = { ...expected[late][0], tid: 999_001, time: H13 + 5_000 };
    const path = join(dir, archiveKey(H13));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, storedFrame(`${JSON.stringify({ local_time: "x", block_time: "x", block_number: 1, events: [[late, lateFill]] })}\n`));

    await track([early]);
    await service({ localDir: dir }).tick(NOW);
    expect(await span(early)).toEqual([H11, H13, "active"]);
    await track([late]);
    // Hour 13 is not due yet: the newcomer is queued, with no coverage claimed.
    expect(await service({ localDir: dir }).tick(NOW)).toEqual([]);
    expect(await span(late)).toEqual([null, null, "active"]);
    expect(await history.archiveSpan(late)).toBeNull();

    const outcomes = await service({ localDir: dir }).tick(NOW + HOUR_MS);
    expect(outcomes).toEqual(["ingested", "ingested", "ingested"]);
    expect(await span(early)).toEqual([H11, H13 + HOUR_MS, "active"]);
    expect(await span(late)).toEqual([H11, H13 + HOUR_MS, "active"]);
    expect(reconcileFills(await stored(late), [...expected[late], lateFill]).exact).toBe(true);
    // The pass re-read hours 12 and 11 for the newcomer only.
    expect(reconcileFills(await stored(early), expected[early]).exact).toBe(true);
  });

  it("excludes an address with too many fills per hour and never certifies it", async () => {
    await track(ADDRESSES);
    await service({ maxFillsPerAddressHour: 150 }).tick(NOW);
    const heavy = "0xb3e475368ed0fa0ad23c04de0423d48a0758806f";
    expect((await span(heavy))?.[2]).toBe("excluded");
    expect(await history.archiveSpan(heavy)).toBeNull();
    expect((await repository.coverageCounts(H11)).excluded).toBe(1);
    expect(await span(ADDRESSES.find((address) => address !== heavy)!)).toEqual([H11, H13, "active"]);
  });

  it("keeps every fill of a heavy address by default: nobody is excluded for trading a lot", async () => {
    await track(ADDRESSES);
    const heavy = "0xb3e475368ed0fa0ad23c04de0423d48a0758806f";
    expect(config().value.archive.maxFillsPerAddressHour).toBe(0);
    await service().tick(NOW);
    expect(await span(heavy)).toEqual([H11, H13, "active"]);
    expect(await stored(heavy)).toHaveLength(expected[heavy].length);
    expect((await repository.coverageCounts(H11)).excluded).toBe(0);
  });

  describe("the backfill window", () => {
    const DAY = 24 * HOUR_MS;
    /** Every hour exists and is empty; the keys asked for are recorded. */
    const recording = () => {
      const keys: string[] = [];
      const store: ArchiveStore = { open: async (key) => {
        keys.push(key);
        const body = storedFrame("");
        return { size: body.length, body: (async function* () { yield body; })(), cancel: async () => undefined };
      } };
      return { keys, store };
    };
    const far = Date.UTC(2025, 4, 25);
    const midnight = Math.floor(NOW / DAY) * DAY;

    it("a pass goes back S3_ARCHIVE_BACKFILL_DAYS, not to the archive's first day; a longer window later extends the same spans", async () => {
      await track(ADDRESSES);
      const first = recording();
      await service({ start: far, backfillDays: 1 }, first.store).tick(NOW);
      // Live hour 12, then 11:00 down to yesterday's midnight.
      expect(first.keys).toHaveLength(1 + 12 + 24);
      expect(first.keys.at(-1)).toBe(archiveKey(midnight - DAY));
      expect(await span(ADDRESSES[0])).toEqual([midnight - DAY, H13, "active"]);
      const status = await service({ start: far, backfillDays: 1 }, first.store).status(NOW);
      expect([status.backfillFloor, status.backfillCursorHour, status.addresses.backfilled, status.addresses.pending]).toEqual([new Date(midnight - DAY), null, ADDRESSES.length, 0]);
      // The floor moves with the calendar: the next day nothing is pending and nothing is read again.
      const next = recording();
      expect(await service({ start: far, backfillDays: 1 }, next.store).tick(NOW + 10 * 60_000)).toEqual([]);

      const longer = recording();
      await service({ start: far, backfillDays: 3 }, longer.store).tick(NOW);
      expect(longer.keys).toHaveLength(48);
      expect([longer.keys[0], longer.keys.at(-1)]).toEqual([archiveKey(midnight - DAY - HOUR_MS), archiveKey(midnight - 3 * DAY)]);
      expect(await span(ADDRESSES[0])).toEqual([midnight - 3 * DAY, H13, "active"]);
      // 90 days from 2026 never ask for the legacy prefix.
      expect([...first.keys, ...longer.keys].every((key) => key.startsWith("node_fills_by_block/"))).toBe(true);
    });

    it("passes are spaced: a joiner, or a longer window, waits for the interval since the last pass began", async () => {
      const [early, late] = [ADDRESSES[0], ADDRESSES[1]];
      await track([early]);
      const options = { start: far, backfillDays: 1, passIntervalHours: 6 };
      const first = recording();
      await service(options, first.store).tick(NOW);
      expect(first.keys).toHaveLength(37);
      expect((await repository.state()).backfillPassStartedAt).toEqual(new Date(NOW));

      await track([late]);
      // Queued strictly before the next run reads its participants (the
      // comparison is to the millisecond).
      await repository.syncTrackedSet();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = recording();
      // The joiner's span starts with the next live hour; no pass yet.
      expect(await service(options, second.store).tick(NOW + HOUR_MS)).toEqual(["ingested"]);
      expect(await span(late)).toEqual([H13, H13 + HOUR_MS, "active"]);
      const status = await service(options, second.store).status(NOW + HOUR_MS);
      expect([status.addresses.backfilled, status.addresses.pending, status.backfillNextPassAt]).toEqual([1, 1, new Date(NOW + 6 * HOUR_MS)]);
      // Until then it is reported as covered only from where its span starts.
      expect(await history.archiveSpan(late)).toEqual({ from: H13 + ARCHIVE_BOUNDARY_MARGIN_MS, through: H13 + HOUR_MS - ARCHIVE_BOUNDARY_MARGIN_MS });

      // Six hours after the first pass began: one pass for the joiner, down to the same floor.
      const later = NOW + 6 * HOUR_MS;
      const third = recording();
      await repository.moveCursor(await repository.state(), { liveNextHour: new Date(Math.floor(later / HOUR_MS) * HOUR_MS) });
      await service(options, third.store).tick(later);
      expect([third.keys.length, third.keys[0], third.keys.at(-1)]).toEqual([13 + 24, archiveKey(H12), archiveKey(midnight - DAY)]);
      expect((await span(late))?.[0]).toBe(midnight - DAY);
      expect((await repository.state()).backfillPassStartedAt).toEqual(new Date(later));
    });

    it("the hour in which the archive changed format is read from both prefixes; legacy lines keep their shape (no twapId key)", async () => {
      const BOUNDARY = Date.UTC(2025, 6, 27, 8);
      const dir = mkdtempSync(join(tmpdir(), "archive-"));
      temp.push(dir);
      const address = ADDRESSES[0];
      const { twapId: _twapId, ...legacy } = { ...expected[address][0], tid: 1, time: BOUNDARY + 60_000 };
      const block = { ...expected[address][0], tid: 2, time: BOUNDARY + 50 * 60_000 };
      const write = (key: string, text: string) => {
        mkdirSync(dirname(join(dir, key)), { recursive: true });
        writeFileSync(join(dir, key), storedFrame(text));
      };
      // The legacy line exactly as the bucket holds it: [address, fill].
      write("node_fills/hourly/20250727/8.lz4", `${JSON.stringify([address, legacy])}\n`);
      write("node_fills_by_block/hourly/20250727/8.lz4", `${JSON.stringify({ local_time: "x", block_time: "x", block_number: 1, events: [[address, block]] })}\n`);
      await track([address]);
      const now = BOUNDARY + HOUR_MS + 30 * 60_000;
      const ingest = service({ localDir: dir, start: BOUNDARY, backfill: false });
      expect(await ingest.tick(now)).toEqual(["ingested"]);
      const fills = await stored(address);
      expect(fills.map((fill) => [fill.tid, "twapId" in fill])).toEqual([[1, false], [2, true]]);
      expect(fills[0]).toEqual(legacy);
      expect((await repository.state()).lastObjectKey).toBe("node_fills/hourly/20250727/8.lz4 + node_fills_by_block/hourly/20250727/8.lz4");

      // With one of the two missing the hour is not certified.
      await truncateAll(db);
      rmSync(join(dir, "node_fills/hourly/20250727/8.lz4"));
      await track([address]);
      expect(await service({ localDir: dir, start: BOUNDARY, backfill: false }).tick(now)).toEqual(["missing"]);
      expect(await span(address)).toEqual([null, null, "active"]);
    });
  });

  it("a hole in the archive leaves coverage partial instead of claiming it", async () => {
    await track(ADDRESSES);
    const ingest = service({ start: H11 - HOUR_MS });
    expect(await ingest.tick(NOW)).toEqual(["ingested", "ingested", "missing"]);
    expect(await span(ADDRESSES[0])).toEqual([H11, H13, "active"]);
    const status = await ingest.status(NOW);
    expect([status.lastError, status.backfillCursorHour, status.addresses.backfilled, status.addresses.pending]).toEqual(["missing_object", null, 0, ADDRESSES.length]);
  });

  it("a malformed object stops its cursor; nothing is certified from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-"));
    temp.push(dir);
    const path = join(dir, archiveKey(H12));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, storedFrame(`${JSON.stringify({ events: [[ADDRESSES[0], expected[ADDRESSES[0]][0]]] })}\n{"events":[["0x12",{}]]}\n`));
    await track(ADDRESSES);
    const ingest = service({ localDir: dir });
    await expect(ingest.tick(NOW)).rejects.toThrow("Fill");
    await ingest.onTick();
    expect((await repository.state()).liveNextHour).toEqual(new Date(H12));
    expect(await span(ADDRESSES[0])).toEqual([null, null, "active"]);
  });

  it("does nothing when disabled", async () => {
    const off = new ArchiveIngestService({ value: { ...testConfig().value } } as AppConfig, repository, new BackgroundJobs());
    expect(off.enabled).toBe(false);
    expect(await off.tick(NOW)).toEqual([]);
    await off.onTick();
    expect(await db.select().from(archiveCoverage)).toHaveLength(0);
  });

  describe("REST history next to the archive", () => {
    const address = "0xb3e475368ed0fa0ad23c04de0423d48a0758806f";
    const mid = expected[address].filter((fill) => fill.twapId == null);
    const template = mid[0];
    // History the archive does not hold: before its first hour, and after its lag.
    const older = Array.from({ length: 2500 }, (_, i) => ({ ...template, tid: 10_000 + i, time: H11 - 86_400_000 + i * 1000, startPosition: undefined }));
    const tail = Array.from({ length: 3 }, (_, i) => ({ ...template, tid: 20_000 + i, time: H13 + 60_000 + i, startPosition: undefined }));
    const all = [...older, ...mid, ...tail];
    const provider = () => {
      const calls: Array<{ kind: string; start: number; end: number; items: number }> = [];
      const info = {
        userFillsByTime: async (_: string, start: number, end: number) => {
          const page = all.filter((fill) => fill.time >= start && fill.time <= end).sort((a, b) => a.time - b.time).slice(0, 2000);
          calls.push({ kind: "regular", start, end, items: page.length });
          return page;
        },
        userTwapSliceFillsByTime: async (_: string, start: number, end: number) => {
          calls.push({ kind: "twap", start, end, items: 0 });
          return [];
        },
      } as unknown as HyperliquidInfoClient;
      return { info, calls };
    };
    const weight = (calls: Array<{ items: number }>) => calls.reduce((sum, call) => sum + 20 + Math.ceil(call.items / 20), 0);
    const until = NOW;
    const run = async (info: HyperliquidInfoClient) => {
      await history.ensure(address, until);
      const worker = new AnalysisHistoryService(history, info);
      for (let i = 0; i < 20 && (await history.state(address))!.status === "pending"; i++) await worker.advance((await history.state(address))!, until);
      return (await history.snapshot(address))!;
    };

    it("reads only what precedes the archive and the tail after it; the snapshot equals the REST-only one", async () => {
      // Before: REST alone.
      const before = provider();
      const restOnly = await run(before.info);
      expect(restOnly.fills).toHaveLength(all.length);
      await truncateAll(db);

      // After: the archive holds hours 11–12.
      await track([address]);
      await service().tick(NOW);
      const after = provider();
      const merged = await run(after.info);
      expect(reconcileFills(merged.fills, restOnly.fills)).toMatchObject({ exact: true, onlyLeft: [], onlyRight: [] });
      expect(merged.through.getTime()).toBe(until);

      const span = (await history.archiveSpan(address))!;
      const regular = after.calls.filter((call) => call.kind === "regular");
      // No request touches the certified span; ranges meet it exactly (no gap).
      expect(regular.every((call) => call.end < span.from || call.start >= span.through)).toBe(true);
      expect(regular.filter((call) => call.end < span.from).at(-1)!.end).toBe(span.from - 1);
      expect(regular.find((call) => call.start >= span.through)!.start).toBe(span.through);
      // TWAP is not trusted to the archive by default: it still scans REST.
      expect(after.calls.filter((call) => call.kind === "twap")).toEqual([{ kind: "twap", start: 0, end: until, items: 0 }]);
      expect({ before: { calls: before.calls.length, weight: weight(before.calls) }, after: { calls: after.calls.length, weight: weight(after.calls) } })
        .toEqual({ before: { calls: 3, weight: 211 }, after: { calls: 4, weight: 208 } });
    });

    // 14,500 rows written and read back: past the default 5 s on a slow CI runner.
    it("costs a fraction for an account whose history sits inside the archive", { timeout: 30_000 }, async () => {
      // 14,500 fills inside the certified span; REST keeps the same fills.
      const spanFrom = H11 + ARCHIVE_BOUNDARY_MARGIN_MS;
      const heavy = Array.from({ length: 14_500 }, (_, i) => ({ ...template, tid: 50_000 + i, time: spanFrom + 1_000 + i * 400, startPosition: undefined }));
      const serve = (calls: Array<{ items: number }>) => ({
        userFillsByTime: async (_: string, start: number, end: number) => {
          const page = heavy.filter((fill) => fill.time >= start && fill.time <= end).slice(0, 2000);
          calls.push({ items: page.length });
          return page;
        },
        userTwapSliceFillsByTime: async () => { calls.push({ items: 0 }); return []; },
      }) as unknown as HyperliquidInfoClient;

      const before: Array<{ items: number }> = [];
      const restOnly = await run(serve(before));
      await truncateAll(db);

      await db.insert(archiveCoverage).values({ address, coveredFrom: new Date(H11), coveredThrough: new Date(H13) });
      await repository.insertFills(heavy.map((fill) => ({ address, fill: fill as HlUserFill })));
      const after: Array<{ items: number }> = [];
      const merged = await run(serve(after));
      expect(reconcileFills(merged.fills, restOnly.fills).exact).toBe(true);
      expect({ calls: before.length, weight: weight(before) }).toEqual({ calls: 9, weight: 906 });
      expect({ calls: after.length, weight: weight(after) }).toEqual({ calls: 3, weight: 60 });
    });

    it("catchUp finishes an archive-covered address in a few pages and reports the cost", async () => {
      await track([address]);
      await service().tick(NOW);
      const { info, calls } = provider();
      const worker = new AnalysisHistoryService(history, info);
      const cost = { calls: 0, weight: 0 };
      expect(await worker.catchUp(address, 8, cost)).toBe(true);
      expect(cost.calls).toBe(calls.length);
      expect((await history.snapshot(address))!.fills.length).toBeGreaterThanOrEqual(all.length);
      // Without archive coverage it declines, leaving the cold path to run.
      expect(await worker.catchUp(ADDRESSES[1], 8)).toBe(false);
      expect(calls.length).toBe(cost.calls);
    });

    it("S3_ARCHIVE_TRUST=none keeps the full REST scan", async () => {
      await track([address]);
      await service().tick(NOW);
      const { info, calls } = provider();
      await history.ensure(address, until);
      const worker = new AnalysisHistoryService(history, info, new BackgroundJobs(), config({ trust: "none" }));
      for (let i = 0; i < 20 && (await history.state(address))!.status === "pending"; i++) await worker.advance((await history.state(address))!, until);
      expect(calls.filter((call) => call.kind === "regular").some((call) => call.start === 0 && call.end === until)).toBe(true);
    });
  });
});
