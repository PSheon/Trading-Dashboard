import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toPortfolioResponse } from "../apps/api/dist/traders/traders.mappers.js";
import { copyScore } from "../apps/api/dist/analytics/copy-score.js";

const root = new URL("../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const hash = path => createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");
const finite = value => typeof value === "number" && Number.isFinite(value);

/** A numeric match cannot certify parity when observation times differ. */
export function comparison(metric, actual, reference, resolution) {
  if (!finite(actual) || !finite(reference)) return { metric, actual: actual ?? null, reference: reference ?? null, status: "unavailable" };
  return { metric, actual, reference, absoluteDifference: Math.abs(actual - reference),
    relativeDifference: reference === 0 ? null : Math.abs((actual - reference) / reference),
    referenceResolution: resolution, withinReferenceResolution: Math.abs(actual - reference) <= resolution };
}
export function portfolioComparison(portfolio, reference, metadata) {
  const rows = [];
  const endTimes = portfolio.flatMap(([, value]) => value.pnlHistory.map(([t]) => t));
  const portfolioEnd = endTimes.length ? Math.max(...endTimes) : null;
  const referenceTime = Date.parse(reference.metricsUpdatedAt);
  for (const [window, roiKey] of [["allTime", "roi"], ["month", "roi30d"], ["week", "roi7d"], ["day", "roi24h"]]) {
    const ours = toPortfolioResponse(portfolio, window, "perp");
    const theirs = reference.perfWindows?.[window] ?? {};
    rows.push({ window, metrics: [
      comparison("roi", ours.roi, reference[roiKey], 0.000001),
      comparison("sharpe", ours.sharpe, theirs.sharpe ?? (window === "allTime" ? reference.sharpe : undefined), 0.0001),
      comparison("maxDrawdown", ours.maxDrawdownPct, theirs.maxDrawdown ?? (window === "allTime" ? reference.maxDrawdown : undefined), 0.000001),
    ] });
  }
  return { ...metadata, referenceComputedAt: reference.metricsUpdatedAt ?? null,
    portfolioEnd: portfolioEnd === null ? null : new Date(portfolioEnd).toISOString(),
    timeDifferenceSeconds: portfolioEnd !== null && Number.isFinite(referenceTime) ? (portfolioEnd - referenceTime) / 1000 : null,
    verdict: "not_time_aligned", // No stored sample certifies identical source snapshots.
    note: "Same address and named windows; source snapshots differ. Numeric differences are observations, not formula pass/fail.", rows };
}
export function scoreComparison(rows) {
  const results = rows.map(([reference, roi, pnl, sharpe, maxDrawdown, returnSamples, spanDays, accountValue], rowIndex) => {
    const actual = copyScore({ roi, pnl, sharpe, maxDrawdown, returnSamples, spanDays, accountValue });
    return { rowIndex, reference, actual, error: actual === null ? null : Math.abs(actual - reference) };
  });
  const scored = results.filter(r => r.error !== null);
  const errors = scored.map(r => r.error).sort((a, b) => a - b);
  const middle = Math.floor(errors.length / 2);
  return { total: results.length, scored: scored.length, unscored: results.filter(r => r.error === null),
    medianAbsoluteError: errors.length ? (errors.length % 2 ? errors[middle] : (errors[middle - 1] + errors[middle]) / 2) : null,
    maxAbsoluteError: errors.at(-1) ?? null,
    withinTen: scored.filter(r => r.error <= 10).length,
    threshold80Agreement: scored.length ? scored.filter(r => (r.reference >= 80) === (r.actual >= 80)).length / scored.length : null,
    largestDifferences: [...scored].sort((a, b) => b.error - a.error).slice(0, 10),
    limitation: "Saved calibration sample, not an independent holdout. No row addresses, split labels or per-row timestamps are stored; rowIndex is not a wallet identity." };
}
export function buildReport() {
  const portfolioPath = "apps/api/test/fixtures/portfolio-copydog-d70c.json";
  const scoresPath = "apps/api/test/fixtures/copydog-copy-score-2026-09-30.json";
  const livePath = "docs/evidence/copydog-live-comparison-2026-09-30.json";
  const saved = read(portfolioPath);
  const live = read(livePath);
  const score = read(scoresPath);
  const components = live.summary.body.copyScoreComponents;
  const account = live.summary.body.account;
  const liveScore = copyScore({ roi: live.summary.body.stats.roi, pnl: live.summary.body.perpPnlSummary.allTime,
    sharpe: components.sharpe_raw, maxDrawdown: components.max_drawdown_raw, returnSamples: components.return_sample_count,
    spanDays: components.span_days, accountValue: account.accountValue });
  return { schemaVersion: 1, generatedAt: new Date().toISOString(),
    calculationSources: ["apps/api/src/traders/traders.mappers.ts", "apps/api/src/analytics/copy-score.ts"].map(path => ({ path, sha256: hash(path) })),
    inputs: [portfolioPath, scoresPath, livePath].map(path => ({ path, sha256: hash(path) })),
    frozenPortfolio: portfolioComparison(saved.portfolio, saved.copydog, { address: "0xd70c9e61ba506a8cf1c25b54d14b25abdc048fd4", source: saved.source }),
    livePortfolio: portfolioComparison(live.portfolio.body, live.summary.body.stats, { address: live.summary.body.address, source: "Fresh public requests; see captured evidence and timestamps" }),
    liveScore: { ...comparison("copyScore", liveScore, live.summary.body.copyScore, 0), inputBasis: "CopyDog published components and account value; isolates fitted-formula error, not end-to-end data parity" },
    scoreCalibrationSample: scoreComparison(score.rows) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildReport();
  const path = new URL("docs/evidence/copydog-numerical-comparison-2026-09-30.json", root);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: fileURLToPath(path), frozenTimeGapSeconds: report.frozenPortfolio.timeDifferenceSeconds,
    liveTimeGapSeconds: report.livePortfolio.timeDifferenceSeconds, liveScore: report.liveScore,
    scoreSample: report.scoreCalibrationSample }, null, 2));
}
