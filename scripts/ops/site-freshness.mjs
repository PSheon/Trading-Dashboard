#!/usr/bin/env node
/**
 * The D19 site-freshness verdict (docs/decisions-2026-10-23.md): the share of
 * trader cards the home and explore boards can show whose figures are older
 * than 24 hours, and whether the coin-icon route answers 200. PASS when the
 * stale share is under 10% and the icon route answers 200. Read-only: one
 * statement in a `BEGIN READ ONLY` transaction, rolled back.
 *
 *   DATABASE_URL=… node scripts/ops/site-freshness.mjs [--base-url https://<web>] [--now <iso>] [--json]
 *   node scripts/ops/site-freshness.mjs --sql-only                      # the query, for psql
 *   node scripts/ops/site-freshness.mjs --input report.json [--base-url …] [--json]
 *
 * --base-url  the web origin; GET <base-url>/api/coin-icon/BTC must answer 200.
 *             The icon route's gate (apps/api's market catalog, in memory) is
 *             reachable only over HTTP; without this the icon is "unchecked" and
 *             the verdict cannot PASS.
 * --now       the clock to judge by (tests); default: now.
 * --sql-only  print the read-only statement instead of running it (see copy-acceptance.mjs).
 * --input     the one JSON line psql printed for that statement.
 * --json      machine-readable report instead of text.
 *
 * Exit 0 on PASS, 1 on FAIL, 2 on an error.
 *
 * The cards: every `discovery_traders` row in the pool with figures
 * (`in_pool`, `portfolio_at` not null) is a candidate of every board
 * (apps/api/src/discovery/boards.ts `figures`: a row without `portfolio_at`
 * is never shown). The stamp a card shows is `portfolio_at` (top 100, KOL,
 * the home rows) or `trades_at` (coin boards, the stocks top 100); the
 * clock appears once it is 24 h old (board-card.tsx MetricsStamp), so
 * "stale" is `stamp <= now - 24 h`; a null stamp shows no clock. Ranking is
 * computed in the api (copy scores over the population), so this counts the
 * whole candidate pool, not the 100 a board cuts: a superset of what is shown.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describeError, loadReport, parseArgs, parseTime, readOnlyScript } from "./ops-db.mjs";

const STALE_SHARE_LIMIT = 0.1;
const ICON_TIMEOUT_MS = 10_000;
/** LEADERBOARD_AS_OF_SQL (apps/api/src/discovery/trader-stats-as-of.ts): when the leaderboard's figures were last confirmed. */
const LEADERBOARD_AS_OF_SQL = `(SELECT CASE WHEN count(*) = 0 THEN NULL ELSE greatest(max(s.updated_at),
  (SELECT li.imported_at FROM leaderboard_imports li WHERE li.chain = 'hyperliquid')) END FROM trader_stats s WHERE s.chain = 'hyperliquid')`;

export function buildQuery(nowMs) {
  const text = `WITH pool AS (SELECT portfolio_at, trades_at FROM discovery_traders WHERE chain = 'hyperliquid' AND in_pool AND portfolio_at IS NOT NULL)
SELECT json_build_object(
  'queried_at', now(),
  'now', $1::timestamptz,
  'cards', (SELECT count(*) FROM pool),
  'stale_portfolio', (SELECT count(*) FROM pool WHERE portfolio_at <= $1::timestamptz - interval '24 hours'),
  'stale_trades', (SELECT count(*) FROM pool WHERE trades_at <= $1::timestamptz - interval '24 hours'),
  'missing_trades_at', (SELECT count(*) FROM pool WHERE trades_at IS NULL),
  'oldest_portfolio_at', (SELECT min(portfolio_at) FROM pool),
  'newest_portfolio_at', (SELECT max(portfolio_at) FROM pool),
  'pool_without_figures', (SELECT count(*) FROM discovery_traders WHERE chain = 'hyperliquid' AND in_pool AND portfolio_at IS NULL),
  'leaderboard_imported_at', (SELECT imported_at FROM leaderboard_imports WHERE chain = 'hyperliquid'),
  'leaderboard_as_of', ${LEADERBOARD_AS_OF_SQL}
) AS report`;
  return { text, params: [new Date(nowMs)] };
}

/** GET <baseUrl>/api/coin-icon/BTC: the status, and whether an SVG came back. */
export async function checkIcon(baseUrl, fetchImpl = fetch) {
  const url = new URL("/api/coin-icon/BTC", baseUrl).href;
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(ICON_TIMEOUT_MS), headers: { accept: "image/svg+xml" } });
    const type = res.headers.get("content-type")?.split(";")[0].trim() ?? null;
    return { url, status: res.status, content_type: type, ok: res.status === 200 && type === "image/svg+xml" };
  } catch (error) {
    return { url, status: null, content_type: null, ok: false, error: describeError(error) };
  }
}

const n = (v) => Number(v ?? 0);
/** The verdict from the statement's JSON and the icon check (null = not checked). */
export function evaluate(report, icon) {
  const cards = n(report.cards), stalePortfolio = n(report.stale_portfolio), staleTrades = n(report.stale_trades);
  const share = (stale) => (cards > 0 ? stale / cards : 0);
  const portfolioShare = share(stalePortfolio), tradesShare = share(staleTrades), worst = Math.max(portfolioShare, tradesShare);
  const reasons = [];
  if (cards === 0) reasons.push("no trader card has figures (discovery pool empty or never computed)");
  if (worst >= STALE_SHARE_LIMIT) reasons.push(`stale cards ${(worst * 100).toFixed(1)}% (limit < ${STALE_SHARE_LIMIT * 100}%): portfolio_at ${stalePortfolio}/${cards}, trades_at ${staleTrades}/${cards}`);
  if (icon === null) reasons.push("coin icon route not checked (pass --base-url https://<web>)");
  else if (!icon.ok) reasons.push(`coin icon route answered ${icon.status ?? "no response"}${icon.content_type ? ` ${icon.content_type}` : ""}${icon.error ? ` (${icon.error})` : ""}, not 200 image/svg+xml`);
  return {
    verdict: reasons.length ? "FAIL" : "PASS", reasons,
    now: report.now ?? null, queried_at: report.queried_at ?? null,
    cards, stale: { portfolio_at: stalePortfolio, trades_at: staleTrades, missing_trades_at: n(report.missing_trades_at) },
    stale_share: { portfolio_at: Number(portfolioShare.toFixed(4)), trades_at: Number(tradesShare.toFixed(4)), worst: Number(worst.toFixed(4)), limit: STALE_SHARE_LIMIT },
    pool_without_figures: n(report.pool_without_figures),
    oldest_portfolio_at: report.oldest_portfolio_at ?? null, newest_portfolio_at: report.newest_portfolio_at ?? null,
    leaderboard: { imported_at: report.leaderboard_imported_at ?? null, as_of: report.leaderboard_as_of ?? null },
    icon,
  };
}

export function render(r) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `cards with figures: ${r.cards} (pool rows without figures: ${r.pool_without_figures}); now ${r.now}`,
    `stale (>= 24 h): portfolio_at ${r.stale.portfolio_at} (${pct(r.stale_share.portfolio_at)}), trades_at ${r.stale.trades_at} (${pct(r.stale_share.trades_at)}), no trades_at ${r.stale.missing_trades_at}; worst ${pct(r.stale_share.worst)}, limit < ${pct(r.stale_share.limit)}`,
    `portfolio_at range: ${r.oldest_portfolio_at} .. ${r.newest_portfolio_at}; leaderboard imported ${r.leaderboard.imported_at}, as of ${r.leaderboard.as_of}`,
    `coin icon: ${r.icon === null ? "unchecked" : `${r.icon.status ?? "no response"} ${r.icon.content_type ?? ""} ${r.icon.url}${r.icon.error ? ` (${r.icon.error})` : ""}`}`,
    r.verdict + (r.reasons.length ? ":\n" + r.reasons.map((x) => `    - ${x}`).join("\n") : ""),
  ];
  return lines.join("\n");
}

async function main(argv) {
  const args = parseArgs(argv, { "base-url": "value", now: "value", json: "flag", "sql-only": "flag", input: "value" });
  const nowMs = args.now === undefined ? Date.now() : parseTime(args.now, "now");
  const { text, params } = buildQuery(nowMs);
  if (args["sql-only"]) { process.stdout.write(readOnlyScript(text, params)); return 0; }
  const report = await loadReport({ databaseUrl: process.env.DATABASE_URL, input: args.input, text, params });
  const icon = args["base-url"] ? await checkIcon(args["base-url"]) : null;
  const result = evaluate(report, icon);
  process.stdout.write((args.json ? JSON.stringify(result, null, 2) : render(result)) + "\n");
  return result.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`site-freshness: ${describeError(error)}`); process.exitCode = 2; });
}
