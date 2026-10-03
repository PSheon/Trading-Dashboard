// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CopyPerformance, EquityHistory, equityPaths, performanceIsStale, performanceBucketMs } from "@/components/copy/copy-performance";
import { createCopyOperation, type CopyPerformanceView } from "@/lib/copy";
import { CopyExposure } from "@/components/copy/copy-portfolio";
import { fixtureCopyOverview } from "@/fixtures/copy";
import type { CopyOverview } from "@/lib/contracts";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const query = vi.hoisted(() => ({ data: undefined as CopyPerformanceView | undefined, isError: false, isPending: false, refetch: vi.fn() }));
vi.mock("@/lib/copy", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/copy")>(), useCopyPerformance: () => query }));

const history = (equities: (number | null)[]): CopyPerformanceView => ({
  strategyId: 1, mode: "paper", window: "7d", from: "2026-10-01T00:00:00Z", to: "2026-10-03T00:00:00Z",
  points: equities.map((equity, i) => ({ time: new Date(Date.UTC(2026, 9, 1, i)).toISOString(), equity, totalPnl: equity === null ? null : 0, netDeposits: equity ?? 100, exposureUsd: 0 })),
  todayPnl: null, coverage: { firstSnapshotAt: "2026-10-01T00:00:00Z", lastSnapshotAt: "2026-10-01T04:00:00Z", complete: false },
});

describe("paper equity history", () => {
  it("breaks the curve across missing valuations without charting a zero", () => {
    const paths = equityPaths(history([100, 120, null, 150, 160]).points);
    expect(paths).toHaveLength(2);
    expect(paths.every((p) => p.includes("L"))).toBe(true);
    expect(equityPaths(history([null, null]).points)).toEqual([]);
  });
  it("plots real equity including deposits and labels the distinction from P&L", () => {
    const data = history([100, 200]);
    expect(equityPaths(data.points)[0]).toBe("M4.00,116.00L396.00,4.00");
    const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><EquityHistory data={data} /></I18nProvider>);
    expect(html).toContain("P&amp;L excludes cash transfers");
    expect(html).toContain("Snapshot stale");
  });
  it("reports missing history and tests age against the latest snapshot", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><EquityHistory data={history([null])} /></I18nProvider>);
    expect(html).toContain("No equity snapshots yet");
    const data = history([100]);
    expect(performanceIsStale(data, Date.parse(data.coverage.lastSnapshotAt!) + 180_001)).toBe(true);
    expect(performanceIsStale(data, Date.parse(data.coverage.lastSnapshotAt!) + 60_000)).toBe(false);
  });
});

it("keeps the cash operation key after a lost response, then rotates after success", async () => {
  const operation = createCopyOperation();
  const keys: string[] = [];
  const send = async (key: string) => { keys.push(key); return "ok"; };
  await expect(operation.run({ id: 1, amountUsd: 50 }, async (key) => { keys.push(key); throw new Error("response lost"); })).rejects.toThrow("response lost");
  await operation.run({ id: 1, amountUsd: 50 }, send);
  await operation.run({ id: 1, amountUsd: 50 }, send);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
});

it("gives distinct operations different keys, and recovers a pending operation after reload", async () => {
  const storageKey = "test:paper-operation";
  const first = createCopyOperation(storageKey);
  let lostKey = "";
  await expect(first.run({ id: 1, amountUsd: 50 }, async (key) => { lostKey = key; throw new Error("lost"); })).rejects.toThrow();
  const reloaded = createCopyOperation(storageKey);
  await reloaded.run({ id: 1, amountUsd: 25 }, async (key) => { expect(key).not.toBe(lostKey); });
  await reloaded.run({ id: 1, amountUsd: 50 }, async (key) => { expect(key).toBe(lostKey); });
  sessionStorage.removeItem(storageKey);
});

it("shows unknown daily P&L as unavailable while preserving a measured zero", () => {
  query.data = history([100]);
  const render = () => renderToStaticMarkup(<I18nProvider locale="en" messages={en}><CopyPerformance strategyId={1} /></I18nProvider>);
  expect(render()).toMatch(/Today’s P&amp;L \(UTC\).*?—/);
  query.data.todayPnl = 0;
  expect(render()).toMatch(/Today’s P&amp;L \(UTC\).*?\$0.00/);
  query.data = undefined;
});

it("keeps exposure unavailable when a mark is missing and warns only for own opposing positions", () => {
  const overview: CopyOverview = JSON.parse(JSON.stringify(fixtureCopyOverview()));
  const render = () => renderToStaticMarkup(<I18nProvider locale="en" messages={en}><CopyExposure overview={overview} /></I18nProvider>);
  const position = overview.strategies[0].positions[0];
  const known = position.notionalUsd;
  position.notionalUsd = null;
  expect(render()).toContain("Exposure valuation unavailable");
  position.notionalUsd = known;
  expect(render()).not.toContain("opposing positions");
  overview.strategies[1].positions.push({ ...position, size: -Math.abs(position.size) });
  expect(render()).toContain("Your paper copies hold opposing positions in the same asset");
});

it("does not discard another control’s uncertain operation when one request succeeds", async () => {
  const storageKey = "test:parallel-paper-operations";
  const first = createCopyOperation(storageKey);
  const second = createCopyOperation(storageKey);
  let finish!: () => void;
  const firstResult = first.run({ id: 1, amountUsd: 10 }, () => new Promise<void>((resolve) => { finish = resolve; }));
  let lostKey = "";
  await expect(second.run({ id: 2, amountUsd: 20 }, async (key) => { lostKey = key; throw new Error("lost"); })).rejects.toThrow();
  finish();
  await firstResult;
  await createCopyOperation(storageKey).run({ id: 2, amountUsd: 20 }, async (key) => { expect(key).toBe(lostKey); });
  sessionStorage.removeItem(storageKey);
});

it("breaks history over absent sampled buckets without breaking adjacent downsampled buckets", () => {
  const data = history([100, 120, 150]);
  const bucket = performanceBucketMs(data);
  const start = Math.floor(Date.parse(data.from) / bucket) * bucket;
  data.points[0].time = new Date(start).toISOString();
  data.points[1].time = new Date(start + bucket).toISOString();
  data.points[2].time = new Date(start + 4 * bucket).toISOString();
  const paths = equityPaths(data.points, 400, 120, bucket);
  expect(paths).toHaveLength(2);
  expect(paths[0]).toContain("L");
  expect(paths[1]).not.toContain("L");
  expect(performanceBucketMs({ from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" })).toBe(120_000);
});

it("releases a rejected withdrawal intent when no ledger mutation occurred", async () => {
  const { ApiError } = await import("@/lib/api");
  const operation = createCopyOperation();
  await expect(operation.run({ id: 1, amountUsd: 500 }, async () => {
    throw new ApiError(409, "Not enough idle collateral", { code: "no_free_collateral" });
  })).rejects.toThrow("Not enough");
  expect(operation.pendingBodies()).toEqual([]);
});
