import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { auditFills, lifetimeComplete, reconcileFills } from "../src/analytics/fill-integrity.js";
import { applyFills, type Trade } from "../src/analytics/trade-reconstruction.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";

/**
 * MANUAL, read-only, against live Hyperliquid, CopyDog's public API and an
 * existing database (not part of `pnpm test`). The correctness gate for
 * the numbers the product shows:
 *
 * 1. Fills: for a sample of tracked traders, the fills our database holds
 *    in a window it claims to cover, against `userFillsByTime` (and TWAP
 *    slices) for the same window — same tids, every field equal — plus the
 *    invariants (no duplicate tid, position continuity, PnL identity).
 *    Rows of origin "s3" are compared like any other, so once the archive
 *    is ingested this same run is the archive-vs-REST reconciliation; the
 *    report splits the counts by origin.
 * 2. Metrics: our stored all-time trade count, win rate and per-coin PnL /
 *    volume against CopyDog's `/summary` and `/performance`, each
 *    difference classified (history depth, snapshot staleness, …).
 *
 *   E2E_RUN_LIVE=1 RECONCILE_DATABASE_URL=postgres://… E2E_SAMPLE=12 E2E_OUT=/tmp/reconcile.json \
 *     pnpm --filter @trading-dashboard/api exec vitest run --config ./vitest.config.e2e.ts test/manual-reconcile.e2e-spec.ts
 *
 * The database session is read-only. REST calls are paced to
 * RECONCILE_WEIGHT_PER_MIN (default 120) so a running api keeps its budget.
 */
const SAMPLE = Number(process.env.E2E_SAMPLE ?? 12);
const WEIGHT_PER_MIN = Number(process.env.RECONCILE_WEIGHT_PER_MIN ?? 120);
const WINDOW_MS = Number(process.env.RECONCILE_WINDOW_HOURS ?? 72) * 3_600_000;
const MAX_PAGES = Number(process.env.RECONCILE_MAX_PAGES ?? 2);
const HL = process.env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz/info";
const COPYDOG = "https://api.copydog.xyz/api/hyperliquid/traders";

let spent = 0;
async function info<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Hyperliquid ${response.status}`);
  const data = await response.json() as unknown[];
  const weight = 20 + Math.ceil(data.length / 20);
  spent += weight;
  await delay((weight / WEIGHT_PER_MIN) * 60_000);
  return data as T;
}

/** Earliest fills from `start`, up to MAX_PAGES; `end` shrinks to what the pages cover. */
async function restWindow(type: "userFillsByTime" | "userTwapSliceFillsByTime", user: string, start: number, end: number) {
  const byTid = new Map<number, HlUserFill>();
  let cursor = start;
  let covered = end;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await info<Array<HlUserFill | { fill: HlUserFill; twapId: number }>>({ type, user, startTime: cursor, endTime: end });
    const batch = raw.map((item) => ("fill" in item ? { ...item.fill, twapId: item.twapId } : item));
    for (const fill of batch) byTid.set(fill.tid, fill);
    if (batch.length < 2000) return { fills: [...byTid.values()], end: covered, complete: true };
    const last = Math.max(...batch.map((fill) => fill.time));
    covered = last - 1;
    if (last <= cursor) break;
    cursor = last;
  }
  // Stopped on a full page: only fills strictly before its last millisecond are certain.
  return { fills: [...byTid.values()].filter((fill) => fill.time <= covered), end: covered, complete: false };
}

async function copydog(address: string, path: string): Promise<Record<string, unknown> | null> {
  await delay(1500);
  const response = await fetch(`${COPYDOG}/${address}/${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  return await response.json() as Record<string, unknown>;
}

const relative = (ours: number, theirs: number) => (theirs === 0 ? (ours === 0 ? 0 : Infinity) : Math.abs(ours - theirs) / Math.abs(theirs));

describe.skipIf(!process.env.E2E_RUN_LIVE)("fills and metrics reconciliation (manual, live)", () => {
  it("compares stored fills with REST and stored metrics with CopyDog", { timeout: 4 * 3_600_000 }, async () => {
    const url = process.env.RECONCILE_DATABASE_URL;
    if (!url) throw new Error("RECONCILE_DATABASE_URL is required");
    const pool = new Pool({ connectionString: url, max: 2, options: "-c default_transaction_read_only=on" });
    try {
      // Tracked set members with stored analytics and recent activity; a
      // hash order keeps the pick independent of size or rank.
      const sample = (await pool.query<{ address: string; source: string; coverage_from: Date | null; fill_cursor: Date; truncated: boolean; fills_read: number; summary: Record<string, unknown>; computed_at: Date }>(`
        SELECT a.address, a.source, a.coverage_from, a.fill_cursor, a.truncated, a.fills_read, a.summary->'all' AS summary, a.computed_at
        FROM trader_analytics a
        WHERE a.fill_cursor > now() - interval '7 days' AND (a.summary->'all'->>'trades')::int > 0
          AND a.address IN (
            SELECT address FROM discovery_traders WHERE in_pool UNION SELECT address FROM kol_traders
            UNION SELECT address FROM user_favorites UNION SELECT address FROM cohort_members
            UNION SELECT address FROM leaders WHERE active UNION SELECT leader_address FROM copy_strategies WHERE status <> 'stopped')
        ORDER BY (a.source = 'tracked') DESC, md5(a.address) LIMIT $1`, [SAMPLE])).rows;
      expect(sample.length).toBeGreaterThanOrEqual(Math.min(10, SAMPLE));

      // A database not yet on migration 0017 has no `origin`: every row is REST's.
      const hasOrigin = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history_fills' AND column_name = 'origin'`)).rowCount === 1;
      const origin = hasOrigin ? "origin" : "'rest'";
      const report = [];
      for (const row of sample) {
        const address = row.address;
        const end = row.fill_cursor.getTime();
        const start = Math.max(row.coverage_from?.getTime() ?? 0, end - WINDOW_MS);
        const regular = await restWindow("userFillsByTime", address, start, end);
        const twap = await restWindow("userTwapSliceFillsByTime", address, start, end);
        const through = Math.min(regular.end, twap.end);
        const rest = [...regular.fills, ...twap.fills].filter((fill) => fill.time <= through);

        const stored = (await pool.query<{ raw: HlUserFill; origin: string }>(`
          SELECT DISTINCT ON (tid) raw, origin FROM (
            SELECT tid, raw, ${origin} AS origin, (source = 'twap') AS twap FROM analysis_history_fills WHERE address = $1 AND time >= to_timestamp($2::double precision / 1000) AND time <= to_timestamp($3::double precision / 1000)
            UNION ALL
            SELECT tid, raw, 'watcher', false FROM fills WHERE address = $1 AND ts >= to_timestamp($2::double precision / 1000) AND ts <= to_timestamp($3::double precision / 1000)
          ) merged ORDER BY tid, twap DESC`, [address, start, through])).rows;
        const ours = stored.map((entry) => entry.raw);
        const origins = stored.reduce<Record<string, number>>((count, entry) => ({ ...count, [entry.origin]: (count[entry.origin] ?? 0) + 1 }), {});
        const reconciliation = reconcileFills(ours, rest);
        const audit = auditFills(address, ours);
        const duplicates = Number((await pool.query(`SELECT count(*) - count(DISTINCT (source, tid)) AS n FROM analysis_history_fills WHERE address = $1`, [address])).rows[0].n);
        const everything = (await pool.query<{ raw: HlUserFill }>(`SELECT raw FROM analysis_history_fills WHERE address = $1`, [address])).rows.map((entry) => entry.raw);
        // Nothing stored proves nothing: null, not a vacuous true.
        const provable = everything.length > 0 ? lifetimeComplete(everything, applyFills(address, new Map<string, Trade>(), everything, null)) : null;

        const summary = await copydog(address, "summary");
        const performance = await copydog(address, "performance");
        const stats = (summary?.stats ?? null) as { totalTrades: number; winRate: number; firstTradeMs: number; metricsUpdatedAt: string; volume: number; perfWindows?: { allTime?: { trades: number; winRate: number } } } | null;
        const theirs = ((performance?.byAsset ?? []) as Array<{ coin: string; trades: number; volume: number; realizedPnl: number }>);
        const mine = (row.summary.coins ?? []) as Array<{ coin: string; trades: number; volume: number; netPnl: number }>;
        const coins = mine.map((coin) => {
          const other = theirs.find((entry) => entry.coin === coin.coin);
          return other ? { coin: coin.coin, trades: [coin.trades, other.trades], pnl: [coin.netPnl, other.realizedPnl], volume: [coin.volume, other.volume],
            tradesEqual: coin.trades === other.trades, pnlClose: relative(coin.netPnl, other.realizedPnl) <= 0.01 || Math.abs(coin.netPnl - other.realizedPnl) <= 1,
            volumeClose: relative(coin.volume, other.volume) <= 0.01 } : { coin: coin.coin, missingAtCopyDog: true };
        });
        const compared = coins.filter((coin): coin is Extract<typeof coin, { tradesEqual: boolean }> => "tradesEqual" in coin);
        const ourTrades = Number(row.summary.trades);
        const ourWinRate = row.summary.winRate as number | null;
        const historyShort = stats ? (row.coverage_from?.getTime() ?? Infinity) > stats.firstTradeMs + 86_400_000 : null;
        const copydogStale = stats ? Date.parse(stats.metricsUpdatedAt) < row.computed_at.getTime() - 3_600_000 : null;
        report.push({
          address, source: row.source,
          window: { from: new Date(start).toISOString(), through: new Date(through).toISOString(), restComplete: regular.complete && twap.complete },
          fills: {
            ours: reconciliation.left, rest: reconciliation.right, origins,
            onlyOurs: reconciliation.onlyLeft.length, onlyRest: reconciliation.onlyRight.length, fieldMismatches: reconciliation.mismatches.length,
            mismatchSample: reconciliation.mismatches.slice(0, 5), exact: reconciliation.exact,
          },
          invariants: { duplicateTidsInWindow: audit.duplicateTids.length, duplicateKeysStored: duplicates, positionBreaks: audit.positionBreaks.length,
            breakSample: audit.positionBreaks.slice(0, 3), pnlIdentityHolds: audit.pnl.holds, pnlDifference: audit.pnl.difference },
          coverage: { from: row.coverage_from, truncated: row.truncated, fillsRead: row.fills_read, lifetimeProvable: provable },
          copydog: stats ? {
            trades: [ourTrades, stats.totalTrades], winRate: [ourWinRate, stats.winRate],
            tradesEqual: ourTrades === stats.totalTrades, winRateDelta: ourWinRate === null ? null : Math.abs(ourWinRate - stats.winRate),
            coinsCompared: compared.length, coinTradesEqual: compared.filter((coin) => coin.tradesEqual).length,
            coinPnlClose: compared.filter((coin) => coin.pnlClose).length, coinVolumeClose: compared.filter((coin) => coin.volumeClose).length,
            firstTrade: new Date(stats.firstTradeMs).toISOString(), metricsUpdatedAt: stats.metricsUpdatedAt,
            cause: ourTrades === stats.totalTrades ? "match" : historyShort ? "history_depth" : copydogStale ? "snapshot_staleness" : "unexplained",
          } : null,
        });
        console.log(address, JSON.stringify({ fills: report.at(-1)!.fills.exact, onlyOurs: reconciliation.onlyLeft.length, onlyRest: reconciliation.onlyRight.length,
          breaks: audit.positionBreaks.length, copydog: report.at(-1)!.copydog?.cause, weight: spent }));
      }
      const totals = {
        traders: report.length,
        fillsExact: report.filter((entry) => entry.fills.exact).length,
        fillsCompared: report.reduce((sum, entry) => sum + entry.fills.rest.count, 0),
        fillsMissingInOurs: report.reduce((sum, entry) => sum + entry.fills.onlyRest, 0),
        fillsExtraInOurs: report.reduce((sum, entry) => sum + entry.fills.onlyOurs, 0),
        fieldMismatches: report.reduce((sum, entry) => sum + entry.fills.fieldMismatches, 0),
        positionBreaks: report.reduce((sum, entry) => sum + entry.invariants.positionBreaks, 0),
        pnlIdentityHolds: report.filter((entry) => entry.invariants.pnlIdentityHolds).length,
        duplicateKeysStored: report.reduce((sum, entry) => sum + entry.invariants.duplicateKeysStored, 0),
        copydogTradesEqual: report.filter((entry) => entry.copydog?.tradesEqual).length,
        copydogCauses: report.reduce<Record<string, number>>((count, entry) => ({ ...count, [entry.copydog?.cause ?? "unavailable"]: (count[entry.copydog?.cause ?? "unavailable"] ?? 0) + 1 }), {}),
        hyperliquidWeight: spent,
      };
      console.log(JSON.stringify(totals, null, 2));
      if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), totals, report }, null, 2));
    } finally {
      await pool.end();
    }
  });
});

/**
 * No network: the invariants over everything stored for each address the
 * analytics claim to cover (watcher `fills` ∪ `analysis_history_fills`,
 * inside `[coverage_from, fill_cursor]`). A break here is a hole in our own
 * data: fills the figures were computed without.
 *
 *   E2E_RUN_STORED=1 RECONCILE_DATABASE_URL=… E2E_OUT=/tmp/stored.json pnpm … -t "stored history"
 */
describe.skipIf(!process.env.E2E_RUN_STORED)("stored history invariants (manual, database only)", () => {
  it("audits every tracked address with analytics", { timeout: 3_600_000 }, async () => {
    const url = process.env.RECONCILE_DATABASE_URL;
    if (!url) throw new Error("RECONCILE_DATABASE_URL is required");
    const pool = new Pool({ connectionString: url, max: 2, options: "-c default_transaction_read_only=on" });
    try {
      const rows = (await pool.query<{ address: string; source: string; coverage_from: Date | null; fill_cursor: Date }>(`
        SELECT address, source, coverage_from, fill_cursor FROM trader_analytics WHERE fill_cursor IS NOT NULL ORDER BY address LIMIT $1`, [Number(process.env.E2E_SAMPLE ?? 500)])).rows;
      const report: Array<{ address: string; source: string; fills: number; breaks: number; firstBreak: { coin: string; at: string } | null; pnlIdentityHolds: boolean }> = [];
      for (const row of rows) {
        const table = row.source === "tracked"
          ? `SELECT tid, raw, false AS twap FROM fills WHERE address = $1 AND ts >= $2 AND ts <= $3`
          : `SELECT tid, raw, (source = 'twap') AS twap FROM analysis_history_fills WHERE address = $1 AND time >= $2 AND time <= $3`;
        const stored = (await pool.query<{ raw: HlUserFill }>(`SELECT DISTINCT ON (tid) raw FROM (${table}) merged ORDER BY tid, twap DESC`,
          [row.address, row.coverage_from ?? new Date(0), row.fill_cursor])).rows.map((entry) => entry.raw);
        const audit = auditFills(row.address, stored);
        report.push({ address: row.address, source: row.source, fills: stored.length, breaks: audit.positionBreaks.length,
          firstBreak: audit.positionBreaks[0] ? { coin: audit.positionBreaks[0].coin, at: new Date(audit.positionBreaks[0].time).toISOString() } : null,
          pnlIdentityHolds: audit.pnl.holds });
      }
      const totals = { addresses: report.length, withStoredFills: report.filter((entry) => entry.fills > 0).length,
        withBreaks: report.filter((entry) => entry.breaks > 0).length, breaks: report.reduce((sum, entry) => sum + entry.breaks, 0),
        pnlIdentityFails: report.filter((entry) => !entry.pnlIdentityHolds).length,
        bySource: Object.fromEntries(["tracked", "hyperliquid"].map((source) => [source, {
          addresses: report.filter((entry) => entry.source === source).length,
          withStoredFills: report.filter((entry) => entry.source === source && entry.fills > 0).length,
          withBreaks: report.filter((entry) => entry.source === source && entry.breaks > 0).length }])) };
      console.log(JSON.stringify(totals, null, 2));
      if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), totals, report }, null, 2));
    } finally {
      await pool.end();
    }
  });
});
