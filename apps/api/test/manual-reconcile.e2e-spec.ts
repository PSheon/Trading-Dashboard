import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { auditFills, lifetimeComplete, positionBreaks, reconcileFills } from "../src/analytics/fill-integrity.js";
import { summarize } from "../src/analytics/trade-metrics.js";
import { applyFills, toRoundTrip, type Trade } from "../src/analytics/trade-reconstruction.js";
import { portfolioNumbers } from "../src/discovery/discovery-figures.js";
import type { HlPortfolioResponse, HlUserFill } from "../src/hyperliquid/types.js";
import { portfolioSeries } from "../src/traders/traders.mappers.js";
import { isOutOfScopeSpotFill } from "../src/watcher/action-classifier.js";

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
 *    Each position break is classified by what REST holds between the two
 *    fills around it: a real hole (regular fills we lack), TWAP slices we
 *    lack, or a jump in Hyperliquid's own chain.
 * 2. Derived metrics: trade count, win rate, per-coin PnL / volume
 *    recomputed from Hyperliquid's fills over the whole claimed range (by
 *    the production reconstruction) against the stored summary.
 * 3. Portfolio figures (PnL, ROI, Sharpe, drawdown, account value) stored
 *    for the discovery pool against the `portfolio` endpoint, aligned to
 *    the time they were stored.
 * 4. Secondary: stored metrics against CopyDog's `/summary` and
 *    `/performance`, each difference classified (RECONCILE_COPYDOG=0 skips).
 *
 * Output: the per-metric pass/fail table (console, and `table` in E2E_OUT),
 * judged against Hyperliquid only. E2E_ADDRESSES=a,b pins the sample.
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
/** Derived metrics are recomputed for traders whose claimed range holds at most this many fills. */
const DERIVED_MAX_FILLS = Number(process.env.RECONCILE_DERIVED_MAX_FILLS ?? 60_000);
const PORTFOLIO_TOLERANCE = Number(process.env.RECONCILE_PORTFOLIO_TOLERANCE ?? 0.02);
const PORTFOLIO_FRESH_MS = 3_600_000;
const COPYDOG_ENABLED = process.env.RECONCILE_COPYDOG !== "0";
const HL = process.env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz/info";
const COPYDOG = "https://api.copydog.xyz/api/hyperliquid/traders";

let spent = 0;
async function info<T>(body: Record<string, unknown>, fixedWeight?: number): Promise<T> {
  let response = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // Another process shares the IP's budget: back off once instead of failing a long run.
  if (response.status === 429) {
    await delay(30_000);
    response = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  if (!response.ok) throw new Error(`Hyperliquid ${response.status}`);
  const data = await response.json() as unknown[];
  const weight = fixedWeight ?? 20 + Math.ceil(data.length / 20);
  spent += weight;
  await delay((weight / WEIGHT_PER_MIN) * 60_000);
  return data as T;
}

/** Earliest fills from `start`, up to `pages`; `end` shrinks to what the pages cover. */
async function restWindow(type: "userFillsByTime" | "userTwapSliceFillsByTime", user: string, start: number, end: number, pages = MAX_PAGES) {
  const byTid = new Map<number, HlUserFill>();
  let cursor = start;
  let covered = end;
  for (let page = 0; page < pages; page++) {
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

type Verdict = "pass" | "fail" | "unverified";
interface Check { metric: string; checked: number; passed: number; maxError: string; verdict: Verdict; note: string }
/** One table row: every checked unit must pass; nothing checked is "unverified", never a pass. */
function check(metric: string, results: Array<{ ok: boolean; error?: number }>, note: string, unit = ""): Check {
  const passed = results.filter((r) => r.ok).length;
  const worst = results.reduce((max, r) => Math.max(max, r.error ?? 0), 0);
  return { metric, checked: results.length, passed, maxError: results.some((r) => r.error !== undefined) ? `${Number(worst.toPrecision(3))}${unit}` : "—",
    verdict: results.length === 0 ? "unverified" : passed === results.length ? "pass" : "fail", note };
}
/** Sums of floats in a different order: equal within rounding noise. */
const sameMoney = (ours: number, theirs: number) => Math.abs(ours - theirs) <= Math.max(0.01, 1e-6 * Math.abs(theirs));
/** Linear interpolation of a `[time, value]` series at `at` (ends clamp). */
function valueAt(series: Array<[number, number]>, at: number): number | null {
  if (series.length === 0) return null;
  if (at <= series[0][0]) return series[0][1];
  for (let i = 1; i < series.length; i++) {
    const [t1, v1] = series[i];
    if (at <= t1) {
      const [t0, v0] = series[i - 1];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (at - t0)) / (t1 - t0);
    }
  }
  return series.at(-1)![1];
}
/** The `portfolio` response as it stood at `at`: later points dropped, one interpolated point added at `at`. */
function portfolioAsOf(raw: HlPortfolioResponse, at: number): HlPortfolioResponse {
  const cut = (series: Array<[number, string]>) => {
    const numeric = series.map(([t, v]) => [Number(t), Number(v)] as [number, number]);
    const kept = series.filter(([t]) => Number(t) < at);
    const value = valueAt(numeric, at);
    return value === null ? kept : [...kept, [at, String(value)] as [number, string]];
  };
  return raw.map(([name, history]) => [name, { ...history, accountValueHistory: cut(history.accountValueHistory), pnlHistory: cut(history.pnlHistory) }]);
}

describe.skipIf(!process.env.E2E_RUN_LIVE)("fills and metrics reconciliation (manual, live)", () => {
  it("compares stored fills, derived metrics and portfolio figures with Hyperliquid", { timeout: 6 * 3_600_000 }, async () => {
    const url = process.env.RECONCILE_DATABASE_URL;
    if (!url) throw new Error("RECONCILE_DATABASE_URL is required");
    const pool = new Pool({ connectionString: url, max: 2, options: "-c default_transaction_read_only=on" });
    try {
      // Tracked set members with stored analytics and recent activity; a
      // hash order keeps the pick independent of size or rank.
      // E2E_ADDRESSES pins the sample (a before/after run must compare the same traders).
      const only = process.env.E2E_ADDRESSES?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) ?? null;
      const sample = (await pool.query<{ address: string; source: string; coverage_from: Date | null; fill_cursor: Date; history_through: Date | null; truncated: boolean; fills_read: number; summary: Record<string, unknown>; computed_at: Date }>(`
        SELECT a.address, a.source, a.coverage_from, a.fill_cursor, a.history_through, a.truncated, a.fills_read, a.summary->'all' AS summary, a.computed_at
        FROM trader_analytics a
        WHERE a.fill_cursor IS NOT NULL AND ($2::text[] IS NOT NULL OR (a.fill_cursor > now() - interval '7 days' AND (a.summary->'all'->>'trades')::int > 0))
          AND ($2::text[] IS NULL OR a.address = ANY($2::text[]))
          AND a.address IN (
            SELECT address FROM discovery_traders WHERE in_pool UNION SELECT address FROM kol_traders
            UNION SELECT address FROM user_favorites UNION SELECT address FROM cohort_members
            UNION SELECT address FROM leaders WHERE active UNION SELECT leader_address FROM copy_strategies WHERE status <> 'stopped')
        ORDER BY (a.source = 'tracked') DESC, md5(a.address) LIMIT $1`, [SAMPLE, only])).rows;
      expect(sample.length).toBeGreaterThanOrEqual(only ? 1 : Math.min(10, SAMPLE));

      // A database not yet on migration 0017 has no `origin`: every row is REST's.
      const hasOrigin = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history_fills' AND column_name = 'origin'`)).rowCount === 1;
      const hasCoverage = (await pool.query(`SELECT to_regclass('fill_coverage') AS t`)).rows[0].t !== null;
      const origin = hasOrigin ? "origin" : "'rest'";
      const report = [];
      for (const row of sample) {
        const address = row.address;
        // What the figures claim: complete from `coverage_from` through this cutoff.
        const end = (row.history_through ?? row.fill_cursor).getTime();
        const claimedFrom = row.coverage_from?.getTime() ?? 0;
        // The whole claimed range when it fits the page budget (the derived
        // metrics need all of it); otherwise only its last window.
        const whole = row.fills_read <= DERIVED_MAX_FILLS;
        const start = whole ? claimedFrom : Math.max(claimedFrom, end - WINDOW_MS);
        const pages = whole ? Math.ceil(DERIVED_MAX_FILLS / 2000) + 2 : MAX_PAGES;
        const regular = await restWindow("userFillsByTime", address, start, end, pages);
        const twap = await restWindow("userTwapSliceFillsByTime", address, start, end, pages);
        const through = Math.min(regular.end, twap.end);
        const rest = [...new Map([...regular.fills, ...twap.fills].filter((fill) => fill.time <= through && !isOutOfScopeSpotFill(fill)).map((fill) => [fill.tid, fill])).values()];
        const restComplete = regular.complete && twap.complete;

        const stored = (await pool.query<{ raw: HlUserFill; origin: string }>(`
          SELECT DISTINCT ON (tid) raw, origin FROM (
            SELECT tid, raw, ${origin} AS origin, (source = 'twap') AS twap FROM analysis_history_fills WHERE address = $1 AND time >= to_timestamp($2::double precision / 1000) AND time <= to_timestamp($3::double precision / 1000)
            UNION ALL
            SELECT tid, raw, 'watcher', false FROM fills WHERE address = $1 AND ts >= to_timestamp($2::double precision / 1000) AND ts <= to_timestamp($3::double precision / 1000)
          ) merged ORDER BY tid, twap DESC`, [address, start, through])).rows.filter((entry) => !isOutOfScopeSpotFill(entry.raw));
        const ours = stored.map((entry) => entry.raw);
        const origins = stored.reduce<Record<string, number>>((count, entry) => ({ ...count, [entry.origin]: (count[entry.origin] ?? 0) + 1 }), {});
        const reconciliation = reconcileFills(ours, rest);
        const audit = auditFills(address, ours);
        const duplicates = Number((await pool.query(`SELECT count(*) - count(DISTINCT (source, tid)) AS n FROM analysis_history_fills WHERE address = $1`, [address])).rows[0].n);
        const everything = (await pool.query<{ raw: HlUserFill }>(`SELECT raw FROM analysis_history_fills WHERE address = $1`, [address])).rows.map((entry) => entry.raw);
        // Nothing stored proves nothing: null, not a vacuous true.
        const provable = everything.length > 0 ? lifetimeComplete(everything, applyFills(address, new Map<string, Trade>(), everything, null)) : null;
        const coverage = hasCoverage ? (await pool.query<{ verified_from: Date | null; verified_through: Date | null; backfill_status: string; breaks: unknown[] }>(
          `SELECT verified_from, verified_through, backfill_status, breaks FROM fill_coverage WHERE address = $1`, [address])).rows[0] ?? null : null;

        // (c) Each break in our stored chain, explained by what REST holds
        // between the two fills around it: regular fills we lack (a real
        // hole), only TWAP slices we lack, or nothing (upstream's own chain
        // has the jump: no fill of ours is missing there).
        const missing = new Set(reconciliation.onlyRight);
        const restByTid = new Map(rest.map((fill) => [fill.tid, fill]));
        const upstreamBreaks = new Set(positionBreaks(rest).map((entry) => entry.tid));
        const breaks = { hole: 0, twap: 0, upstream: 0, unknown: 0 };
        for (const entry of audit.positionBreaks) {
          const between = [...missing].map((tid) => restByTid.get(tid)!).filter((fill) => fill.coin === entry.coin && fill.time >= entry.after && fill.time <= entry.time);
          if (between.some((fill) => fill.twapId == null)) breaks.hole += 1;
          else if (between.length > 0) breaks.twap += 1;
          else if (upstreamBreaks.has(entry.tid) || restComplete) breaks.upstream += 1;
          else breaks.unknown += 1;
        }

        // (a) Derived metrics from Hyperliquid's fills alone, through the
        // same cutoff, by the production reconstruction and summary.
        let derived: Record<string, unknown> | null = null;
        if (whole && restComplete) {
          const result = applyFills(address, new Map<string, Trade>(), rest, null);
          const truth = summarize(result.touched.map((trade) => toRoundTrip(trade, end)), "all", end);
          const mine = row.summary as unknown as { trades: number; wins: number; winRate: number | null; netPnl: number; volume: number; fees: number; coins: Array<{ coin: string; trades: number; netPnl: number; volume: number }> };
          const coins = [...new Set([...truth.coins.map((coin) => coin.coin), ...mine.coins.map((coin) => coin.coin)])].map((name) => {
            const a = mine.coins.find((coin) => coin.coin === name) ?? { trades: 0, netPnl: 0, volume: 0 };
            const b = truth.coins.find((coin) => coin.coin === name) ?? { trades: 0, netPnl: 0, volume: 0 };
            return { coin: name, trades: [a.trades, b.trades], netPnl: [a.netPnl, b.netPnl], volume: [a.volume, b.volume],
              tradesEqual: a.trades === b.trades, pnlEqual: sameMoney(a.netPnl, b.netPnl), volumeEqual: sameMoney(a.volume, b.volume) };
          });
          derived = {
            trades: [mine.trades, truth.trades], wins: [mine.wins, truth.wins], winRate: [mine.winRate, truth.winRate], netPnl: [mine.netPnl, truth.netPnl], volume: [mine.volume, truth.volume],
            tradesEqual: mine.trades === truth.trades, winRateEqual: mine.wins === truth.wins && mine.trades === truth.trades,
            winRateDelta: Math.abs((mine.winRate ?? 0) - (truth.winRate ?? 0)), netPnlEqual: sameMoney(mine.netPnl, truth.netPnl), volumeEqual: sameMoney(mine.volume, truth.volume),
            coins: coins.length, coinTradesEqual: coins.filter((coin) => coin.tradesEqual).length, coinPnlEqual: coins.filter((coin) => coin.pnlEqual).length, coinVolumeEqual: coins.filter((coin) => coin.volumeEqual).length,
            coinPnlMaxError: coins.reduce((max, coin) => Math.max(max, Math.abs(coin.netPnl[0] - coin.netPnl[1])), 0),
            coinVolumeMaxError: coins.reduce((max, coin) => Math.max(max, Math.abs(coin.volume[0] - coin.volume[1])), 0),
            coinMismatches: coins.filter((coin) => !coin.tradesEqual || !coin.pnlEqual || !coin.volumeEqual).slice(0, 5),
          };
        }

        // (b) Portfolio figures stored for the discovery pool, against the
        // `portfolio` endpoint as it stood when they were stored.
        let portfolio: Record<string, unknown> | null = null;
        const figures = (await pool.query<{ account_value: string | null; pnl_all: string | null; roi_all: string | null; pnl_30d: string | null; roi_30d: string | null; sharpe: string | null; max_drawdown: string | null; portfolio_at: Date | null }>(
          `SELECT account_value, pnl_all, roi_all, pnl_30d, roi_30d, sharpe, max_drawdown, portfolio_at FROM discovery_traders WHERE address = $1`, [address])).rows[0];
        if (figures?.portfolio_at) {
          const raw = await info<HlPortfolioResponse>({ type: "portfolio", user: address }, 20);
          const at = figures.portfolio_at.getTime();
          const then = portfolioNumbers(portfolioAsOf(raw, at));
          const accountValue = valueAt(portfolioSeries(raw, "allTime", "all").accountValue, at);
          const fresh = Date.now() - at < PORTFOLIO_FRESH_MS;
          const pair = (stored: string | null, truth: number | null, relative: number, absolute: number) => {
            if (stored === null || truth === null) return { stored: stored === null ? null : Number(stored), hyperliquid: truth, error: null, ok: stored === null && truth === null };
            const error = Math.abs(Number(stored) - truth);
            return { stored: Number(stored), hyperliquid: truth, error, ok: error <= Math.max(absolute, relative * Math.abs(truth)) };
          };
          portfolio = {
            storedAt: figures.portfolio_at.toISOString(), ageMinutes: Math.round((Date.now() - at) / 60_000),
            pnlAll: pair(figures.pnl_all, then.pnlAll, PORTFOLIO_TOLERANCE, 1), roiAll: pair(figures.roi_all, then.roiAll, PORTFOLIO_TOLERANCE, 0.001),
            sharpe: pair(figures.sharpe, then.sharpe, 0, 0.05), maxDrawdown: pair(figures.max_drawdown, then.maxDrawdown, 0, 0.005),
            accountValue: pair(figures.account_value, accountValue, PORTFOLIO_TOLERANCE, 1),
            // A rolling 30-day window cannot be rebuilt for a past instant: compared only while fresh.
            pnl30d: fresh ? pair(figures.pnl_30d, then.pnl30d, PORTFOLIO_TOLERANCE, 1) : null, roi30d: fresh ? pair(figures.roi_30d, then.roi30d, PORTFOLIO_TOLERANCE, 0.001) : null,
          };
        }

        const summary = COPYDOG_ENABLED ? await copydog(address, "summary") : null;
        const performance = COPYDOG_ENABLED ? await copydog(address, "performance") : null;
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
        const cause = !stats ? "unavailable" : ourTrades === stats.totalTrades ? "match" : historyShort ? "history_depth" : copydogStale ? "snapshot_staleness" : "unexplained";
        report.push({
          address, source: row.source,
          window: { from: new Date(start).toISOString(), through: new Date(through).toISOString(), restComplete, wholeClaimedRange: whole },
          fills: {
            ours: reconciliation.left, rest: reconciliation.right, origins,
            onlyOurs: reconciliation.onlyLeft.length, onlyRest: reconciliation.onlyRight.length, fieldMismatches: reconciliation.mismatches.length,
            mismatchSample: reconciliation.mismatches.slice(0, 5), exact: reconciliation.exact,
            rawBacked: ours.length > 0 || rest.length === 0,
          },
          invariants: { duplicateTidsInWindow: audit.duplicateTids.length, duplicateKeysStored: duplicates, positionBreaks: audit.positionBreaks.length, breakCauses: breaks,
            breakSample: audit.positionBreaks.slice(0, 3), pnlIdentityHolds: audit.pnl.holds, pnlDifference: audit.pnl.difference },
          coverage: { from: row.coverage_from, through: row.history_through, truncated: row.truncated, fillsRead: row.fills_read, lifetimeProvable: provable,
            verified: coverage ? { from: coverage.verified_from, through: coverage.verified_through, backfill: coverage.backfill_status, unexplainedBreaks: coverage.breaks.length } : null },
          derived, portfolio,
          copydog: stats ? {
            trades: [ourTrades, stats.totalTrades], winRate: [ourWinRate, stats.winRate],
            tradesEqual: ourTrades === stats.totalTrades, winRateDelta: ourWinRate === null ? null : Math.abs(ourWinRate - stats.winRate),
            coinsCompared: compared.length, coinTradesEqual: compared.filter((coin) => coin.tradesEqual).length,
            coinPnlClose: compared.filter((coin) => coin.pnlClose).length, coinVolumeClose: compared.filter((coin) => coin.volumeClose).length,
            firstTrade: new Date(stats.firstTradeMs).toISOString(), metricsUpdatedAt: stats.metricsUpdatedAt,
            cause,
          } : null,
        });
        console.log(address, JSON.stringify({ fills: reconciliation.exact, onlyOurs: reconciliation.onlyLeft.length, onlyRest: reconciliation.onlyRight.length,
          breaks, derived: derived ? { trades: derived.tradesEqual, coins: `${String(derived.coinPnlEqual)}/${String(derived.coins)}` } : null, copydog: stats ? cause : undefined, weight: spent }));
      }
      const totals = {
        traders: report.length,
        fillsExact: report.filter((entry) => entry.fills.exact).length,
        fillsCompared: report.reduce((sum, entry) => sum + entry.fills.rest.count, 0),
        fillsMissingInOurs: report.reduce((sum, entry) => sum + entry.fills.onlyRest, 0),
        fillsExtraInOurs: report.reduce((sum, entry) => sum + entry.fills.onlyOurs, 0),
        fieldMismatches: report.reduce((sum, entry) => sum + entry.fills.fieldMismatches, 0),
        positionBreaks: report.reduce((sum, entry) => sum + entry.invariants.positionBreaks, 0),
        breakCauses: report.reduce((sum, entry) => ({ hole: sum.hole + entry.invariants.breakCauses.hole, twap: sum.twap + entry.invariants.breakCauses.twap,
          upstream: sum.upstream + entry.invariants.breakCauses.upstream, unknown: sum.unknown + entry.invariants.breakCauses.unknown }), { hole: 0, twap: 0, upstream: 0, unknown: 0 }),
        pnlIdentityHolds: report.filter((entry) => entry.invariants.pnlIdentityHolds).length,
        duplicateKeysStored: report.reduce((sum, entry) => sum + entry.invariants.duplicateKeysStored, 0),
        copydogTradesEqual: report.filter((entry) => entry.copydog?.tradesEqual).length,
        copydogCauses: report.reduce<Record<string, number>>((count, entry) => ({ ...count, [entry.copydog?.cause ?? "unavailable"]: (count[entry.copydog?.cause ?? "unavailable"] ?? 0) + 1 }), {}),
        hyperliquidWeight: spent,
      };

      // (d) One row per metric, judged against Hyperliquid only.
      const derivedOf = report.flatMap((entry) => (entry.derived ? [entry.derived as Record<string, number | boolean>] : []));
      const finished = report.slice();
      const portfolioOf = (key: string) => finished.flatMap((entry) => {
        const value = (entry.portfolio as Record<string, { ok: boolean; error: number | null } | null> | null)?.[key];
        return value ? [{ ok: value.ok, error: value.error ?? undefined }] : [];
      });
      const coinRow = (key: "coinTradesEqual" | "coinPnlEqual" | "coinVolumeEqual", error?: "coinPnlMaxError" | "coinVolumeMaxError") =>
        derivedOf.flatMap((entry) => Array.from({ length: Number(entry.coins) }, (_, index) => ({ ok: index < Number(entry[key]), error: error ? Number(entry[error]) : undefined })));
      const skipped = report.length - derivedOf.length;
      const derivedNote = `recomputed from Hyperliquid fills over the whole claimed range${skipped ? `; ${skipped} trader(s) not recomputed (range above ${DERIVED_MAX_FILLS} fills or REST read incomplete)` : ""}`;
      const table: Check[] = [
        check("Stored fill content (every compared field of shared tids)", report.map((entry) => ({ ok: entry.fills.fieldMismatches === 0, error: entry.fills.fieldMismatches })), "traders; error = mismatching fields", " fields"),
        check("Fill completeness in the claimed range", report.map((entry) => ({ ok: entry.fills.onlyRest === 0, error: entry.fills.onlyRest })), "traders; error = fills Hyperliquid has and we lack", " fills"),
        check("No fill of ours unknown to Hyperliquid", report.map((entry) => ({ ok: entry.fills.onlyOurs === 0, error: entry.fills.onlyOurs })), "traders", " fills"),
        check("Raw fills stored for the claimed range", report.map((entry) => ({ ok: entry.fills.rawBacked })), "traders; fail = figures with no stored fill behind them"),
        check("Position continuity: no real hole", report.map((entry) => ({ ok: entry.invariants.breakCauses.hole + entry.invariants.breakCauses.twap + entry.invariants.breakCauses.unknown === 0,
          error: entry.invariants.breakCauses.hole + entry.invariants.breakCauses.twap })), `traders; breaks: ${totals.breakCauses.hole} missing regular fills, ${totals.breakCauses.twap} missing TWAP slices, ${totals.breakCauses.upstream} in Hyperliquid's own chain (not ours), ${totals.breakCauses.unknown} undetermined`, " breaks"),
        check("No double counting (Σ closedPnl = trade PnL; no duplicate key)", report.map((entry) => ({ ok: entry.invariants.pnlIdentityHolds && entry.invariants.duplicateKeysStored === 0 })), "traders"),
        check("Trade count", derivedOf.map((entry) => ({ ok: Boolean(entry.tradesEqual) })), derivedNote),
        check("Win rate", derivedOf.map((entry) => ({ ok: Boolean(entry.winRateEqual), error: Number(entry.winRateDelta) })), derivedNote),
        check("Net PnL (all closed trades)", derivedOf.map((entry) => ({ ok: Boolean(entry.netPnlEqual) })), derivedNote),
        check("Per-coin trade count", coinRow("coinTradesEqual"), "trader × coin"),
        check("Per-coin PnL", coinRow("coinPnlEqual", "coinPnlMaxError"), "trader × coin; error in USD", " USD"),
        check("Per-coin volume", coinRow("coinVolumeEqual", "coinVolumeMaxError"), "trader × coin; error in USD", " USD"),
        check("Portfolio PnL (perp, all-time)", portfolioOf("pnlAll"), `vs \`portfolio\` interpolated at the stored time; tolerance ${PORTFOLIO_TOLERANCE * 100}%`, " USD"),
        check("Portfolio ROI (perp, all-time)", portfolioOf("roiAll"), `tolerance ${PORTFOLIO_TOLERANCE * 100}%`),
        check("Sharpe", portfolioOf("sharpe"), "tolerance ±0.05"),
        check("Max drawdown", portfolioOf("maxDrawdown"), "tolerance ±0.005"),
        check("Account value", portfolioOf("accountValue"), `stored leaderboard value vs \`portfolio\` account value at the stored time; tolerance ${PORTFOLIO_TOLERANCE * 100}%`, " USD"),
        check("30-day PnL / ROI", [...portfolioOf("pnl30d"), ...portfolioOf("roi30d")], "only figures stored within the last hour (a rolling window cannot be rebuilt for a past instant)"),
      ];
      console.log(JSON.stringify(totals, null, 2));
      console.log(["| Metric | Checked | Passed | Max error | Verdict | Note |", "| --- | --- | --- | --- | --- | --- |",
        ...table.map((line) => `| ${line.metric} | ${line.checked} | ${line.passed} | ${line.maxError} | ${line.verdict} | ${line.note} |`)].join("\n"));
      if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), totals, table, report }, null, 2));
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
      // The claim: `[coverage_from, history_through ?? fill_cursor]`. For a
      // watched address that is its verified span; rows stored outside it
      // (the far side of an old hole) are kept but not claimed.
      const rows = (await pool.query<{ address: string; source: string; coverage_from: Date | null; fill_cursor: Date; history_through: Date | null }>(`
        SELECT address, source, coverage_from, fill_cursor, history_through FROM trader_analytics WHERE fill_cursor IS NOT NULL ORDER BY address LIMIT $1`, [Number(process.env.E2E_SAMPLE ?? 500)])).rows;
      const report: Array<{ address: string; source: string; fills: number; breaks: number; firstBreak: { coin: string; at: string } | null; pnlIdentityHolds: boolean }> = [];
      for (const row of rows) {
        const table = row.source === "tracked"
          ? `SELECT tid, raw, false AS twap FROM fills WHERE address = $1 AND ts >= $2 AND ts <= $3`
          : `SELECT tid, raw, (source = 'twap') AS twap FROM analysis_history_fills WHERE address = $1 AND time >= $2 AND time <= $3`;
        const stored = (await pool.query<{ raw: HlUserFill }>(`SELECT DISTINCT ON (tid) raw FROM (${table}) merged ORDER BY tid, twap DESC`,
          [row.address, row.coverage_from ?? new Date(0), row.history_through ?? row.fill_cursor])).rows.map((entry) => entry.raw);
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
