import { BadRequestException } from "@nestjs/common";
import { equitySnapshots, positionSnapshots } from "@trading-dashboard/shared/database";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { ChartSnapshotsRepository } from "../src/traders/chart-snapshots.repository.js";
import { ChartSnapshotsService, MAX_CHART_SNAPSHOTS, MAX_SNAPSHOT_POSITIONS } from "../src/traders/chart-snapshots.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const A = "0x" + "ab".repeat(20);
const MIN = 60_000;
const NOW = new Date(Date.UTC(2026, 9, 4, 12, 0));

describe("chart snapshots: what a trader held along the chart (CopyDog's chart-snapshots), from stored 5-minute snapshots", () => {
  const db = getTestDb();
  const service = new ChartSnapshotsService(new ChartSnapshotsRepository(db));
  beforeEach(() => truncateAll(db));
  afterAll(closeTestDb);

  async function snapshots(from: Date, to: Date, positionsAt: (t: number) => Array<{ coin: string; szi: string; entryPx: string | null; upnl: string | null }>) {
    const equity = [];
    const positions = [];
    for (let t = from.getTime(); t <= to.getTime(); t += 5 * MIN) {
      equity.push({ address: A, ts: new Date(t), accountValue: "1000" });
      for (const p of positionsAt(t)) positions.push({ address: A, coin: p.coin, ts: new Date(t), szi: p.szi, entryPx: p.entryPx, unrealizedPnl: p.upnl });
    }
    for (let i = 0; i < equity.length; i += 1000) await db.insert(equitySnapshots).values(equity.slice(i, i + 1000));
    for (let i = 0; i < positions.length; i += 1000) await db.insert(positionSnapshots).values(positions.slice(i, i + 1000));
  }

  it("an address never watched has no coverage and no snapshots; unknown windows and kinds are refused", async () => {
    expect(await service.read(A, {}, NOW)).toEqual({ address: A, window: "allTime", kind: "perp", coverageStart: null, snapshots: [] });
    await expect(service.read(A, { window: "year" }, NOW)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.read(A, { kind: "spot" }, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("spreads at most 60 snapshots over the window, keeps the latest, derives mark and notional, orders positions by size, and a flat time has none", async () => {
    const start = new Date(NOW.getTime() - 2 * 86_400_000);
    // Long BTC throughout; short ETH in the last 6 hours; flat (no rows) between 10 and 9 hours ago.
    await snapshots(start, NOW, (t) => {
      if (t > NOW.getTime() - 10 * 3_600_000 && t < NOW.getTime() - 9 * 3_600_000) return [];
      const list: Array<{ coin: string; szi: string; entryPx: string | null; upnl: string | null }> = [{ coin: "BTC", szi: "0.5", entryPx: "100000", upnl: "1000" }];
      if (t >= NOW.getTime() - 6 * 3_600_000) list.push({ coin: "ETH", szi: "-100", entryPx: "4000", upnl: null });
      return list;
    });
    const all = await service.read(A, { window: "allTime" }, NOW);
    expect(all.coverageStart?.toISOString()).toBe(start.toISOString());
    expect(all.snapshots.length).toBeGreaterThan(40);
    expect(all.snapshots.length).toBeLessThanOrEqual(MAX_CHART_SNAPSHOTS + 1);
    const latest = all.snapshots.at(-1)!;
    expect(latest.t).toBe(NOW.getTime());
    expect(latest.n).toBe(2);
    // BTC: mark = entry + upnl / size = 102,000, notional 51,000. ETH: no upnl, so no mark: listed after.
    expect(latest.positions).toEqual([
      { coin: "BTC", szi: 0.5, entryPx: 100_000, markPx: 102_000, notional: 51_000, upnl: 1000 },
      { coin: "ETH", szi: -100, entryPx: 4000, markPx: null, notional: null, upnl: null },
    ]);
    // A snapshot's total uPnL is unknown when a position's is.
    expect(latest.upnl).toBeNull();
    expect(all.snapshots[0]!.upnl).toBe(1000);
    // Times strictly increase.
    expect(all.snapshots.every((s, i) => i === 0 || s.t > all.snapshots[i - 1]!.t)).toBe(true);

    const day = await service.read(A, { window: "day" }, NOW);
    expect(day.snapshots[0]!.t).toBeGreaterThanOrEqual(NOW.getTime() - 86_400_000);
    const flat = day.snapshots.filter((s) => s.t > NOW.getTime() - 10 * 3_600_000 && s.t < NOW.getTime() - 9 * 3_600_000);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((s) => s.n === 0 && s.positions.length === 0 && s.upnl === 0)).toBe(true);
  });

  it("caps a snapshot at 20 positions, largest first, while n counts them all", async () => {
    await snapshots(new Date(NOW.getTime() - 5 * MIN), NOW, () =>
      Array.from({ length: 25 }, (_, i) => ({ coin: `C${i}`, szi: String(i + 1), entryPx: "10", upnl: "0" })));
    const res = await service.read(A, { window: "day" }, NOW);
    const s = res.snapshots.at(-1)!;
    expect(s.n).toBe(25);
    expect(s.positions).toHaveLength(MAX_SNAPSHOT_POSITIONS);
    expect(s.positions[0]!.coin).toBe("C24");
    expect(s.positions.at(-1)!.coin).toBe("C5");
  });
});
