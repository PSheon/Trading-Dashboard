#!/usr/bin/env node
// Copy harness — five-source reconciliation for one copy.
//
// Sources:
//   L  leader fills       (userFillsByTime on the leader's network)
//   D  Orbie dispatches   (copy_live_dispatches + copy_live_executions)
//   F  follower fills     (userFillsByTime on the follower's network)
//   C  follower state     (clearinghouseState)
//   P  Orbie portfolio    (GET /me/copy/live/portfolio, optional)
//
// Checks (checks.mjs; each failure is listed; exit 1 when any fails):
//   1. every leader order after --since has a dispatch row (or is merged into one), none silently missing;
//   2. no dispatch is refused for signal age (signal_expired / merged_signal_expired);
//   3. every leg is refused for an allowed reason (--allow-refusal; default no_follower_position,
//      live_market_hip3_unsupported), merged into a lead, or has follower fills on the leader's side;
//   4. an open's fill is the fixed amount: --per-trade-usd / its limit price at szDecimals (one lot of
//      rounding, or the exchange-minimum round-up within --max-per-trade-usd);
//   5. the follower's leverage per coin (activeAssetData) is at most --max-leverage;
//   6. the follower's position per coin has the leader's direction, and it is flat when the leader is;
//   7. no follower order outside the dispatched legs and the stop's / owner's reduce-only closes;
//   8. the portfolio's positions and equity equal C (when P is given);
//   plus latency: received − leader, sent − leader and first follower fill − leader, p50/p95/max.
//
// Usage (from the repo root):
//   node scripts/copy-harness/reconcile.mjs --leader 0x… --leader-network testnet \
//     --follower 0x… --network testnet --since 2026-10-07T01:00:00Z \
//     --db ssh|env|<postgres url> [--portfolio-url https://…/api/hl/me/copy/live/portfolio]
// `--db env` reads the URL from HARNESS_DATABASE_URL (so it never shows in `ps`).
// `--db none` needs no key or database at all: only the exchange's public
// reads (L, F, C), so the dispatch checks 1–3 are skipped and listed as such.
// `--stage` is the mainnet Stage preset: --network mainnet --leader-network
// mainnet and, unless given, --db none, the Stage portfolio URL and Stage's
// caps (--max-leverage 3 --max-per-trade-usd 15; add --per-trade-usd for the copy's amount).
// Rules: --per-trade-usd N [--max-per-trade-usd N] [--min-order-usd 10] [--max-leverage N]
//   [--allow-refusal reason[:COIN]]… (repeatable; a scenario's expected refusal).
//   node scripts/copy-harness/reconcile.mjs --stage --leader 0x… --follower 0x… --since 2026-10-07T01:00:00Z
// The portfolio needs HARNESS_BEARER (the follower's Privy access token) in the environment;
// the portfolio holds no balances, so P is the copy's account snapshot
// (GET …/me/copy/execution-wallets/:id/snapshot, the figures the portfolio page shows).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_ALLOWED_REFUSALS, evaluate, parseAllowedRefusals } from "./checks.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const leader = flag("leader")?.toLowerCase(), follower = flag("follower")?.toLowerCase();
const stage = args.includes("--stage");
const leaderNet = flag("leader-network", "mainnet"), net = flag("network", stage ? "mainnet" : "testnet");
const since = Date.parse(flag("since", ""));
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const num = (name, fallback) => { const v = flag(name); if (v === undefined) return fallback; const n = Number(v); if (!(n > 0)) { console.error(`--${name}: a positive number`); process.exit(2); } return n; };
const perTradeUsd = num("per-trade-usd", null), maxPerTradeUsd = num("max-per-trade-usd", stage ? 15 : null), minOrderUsd = num("min-order-usd", 10), maxLeverage = num("max-leverage", stage ? 3 : null);
const rules = { allowedRefusals: [...DEFAULT_ALLOWED_REFUSALS, ...parseAllowedRefusals(all("allow-refusal"))],
  sizing: perTradeUsd ? { perTradeUsd, maxPerTradeUsd: maxPerTradeUsd ?? perTradeUsd, minOrderUsd } : null, maxLeverage };
const db = flag("db", stage ? "none" : "ssh"), portfolioUrl = flag("portfolio-url", stage && process.env.HARNESS_BEARER ? "https://web-staging-9f98.up.railway.app/api/hl/me/copy/live/portfolio" : undefined);
if (!["testnet", "mainnet"].includes(leaderNet) || !["testnet", "mainnet"].includes(net)) { console.error("--network and --leader-network: mainnet or testnet"); process.exit(2); }
if (!/^0x[0-9a-f]{40}$/.test(leader ?? "") || !/^0x[0-9a-f]{40}$/.test(follower ?? "") || !Number.isFinite(since)) {
  console.error("usage: --leader 0x… --follower 0x… --since <ISO> [--leader-network mainnet|testnet] [--network testnet|mainnet] [--db ssh|<url>]");
  process.exit(2);
}
const INFO = { mainnet: "https://api.hyperliquid.xyz/info", testnet: "https://api.hyperliquid-testnet.xyz/info" };
const info = async (network, body) => { const r = await fetch(INFO[network], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${network} ${body.type} ${r.status}`); return r.json(); };

// Orbie's rows: over SSH to the Stage Postgres (read-only), or a local database URL.
const SSH = ["-o", "BatchMode=yes", "-i", `${process.env.HOME}/.ssh/id_ed25519`, "25866604-3d9a-40cf-a29a-f680c43b8235@ssh.railway.com"];
async function query(sql) {
  if (db === "none") return [];
  if (db === "ssh") {
    // The SQL goes on stdin: no shell quoting of the statement.
    const out = execFileSync("ssh", [...SSH, `psql -U "$PGUSER" -d "$PGDATABASE" -At -F '\t' -v ON_ERROR_STOP=1`], { encoding: "utf8", input: `${sql};\n` });
    return out.trim() ? out.trim().split("\n").map((line) => line.split("\t")) : [];
  }
  const require = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"));
  const { default: pg } = await import(pathToFileURL(require.resolve("pg")).href);
  const url = db === "env" ? process.env.HARNESS_DATABASE_URL : db;
  if (!url) throw new Error("--db env needs HARNESS_DATABASE_URL");
  const client = new pg.Client({ connectionString: url }); await client.connect();
  try { return (await client.query({ text: sql, rowMode: "array" })).rows.map((r) => r.map((v) => v instanceof Date ? v.toISOString() : v === null ? "" : String(v))); }
  finally { await client.end(); }
}
const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Number(s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)); };

const failures = [];
const fail = (check, detail) => failures.push({ check, ...detail });

// L — leader fills after `since` (perp only).
const leaderFills = (await info(leaderNet, { type: "userFillsByTime", user: leader, startTime: since })).filter((f) => !f.coin.startsWith("@") && !f.coin.includes(":"));
const leaderOrders = new Set(leaderFills.map((f) => f.oid));

// D — dispatches of copies of this leader into this follower account.
const dispatches = (await query(`select d.id, d.source_fill_id, d.leg, d.coin, d.state, coalesce(d.reason,''), coalesce(d.execution_key,''),
  extract(epoch from d.leader_time)*1000, extract(epoch from d.received_at)*1000, coalesce(extract(epoch from d.sent_at)*1000,0), coalesce(d.adjustment_id,''), coalesce(e.state,''), coalesce(e.cloid,''),
  coalesce(e.record->'action'->'orders'->0->>'s',''), coalesce(e.record->'action'->'orders'->0->>'p',''), coalesce(e.record->'action'->'orders'->0->>'r','false')
  from copy_live_dispatches d join copy_live_mandates m on m.id = d.mandate_id left join copy_live_executions e on e.key = d.execution_key
  where lower(m.leader_address) = ${quote(leader)} and lower(m.account_address) = ${quote(follower)} and d.leader_time >= to_timestamp(${since / 1000})`))
  .map(([id, sourceFillId, leg, coin, state, reason, executionKey, leaderTime, receivedAt, sentAt, adjustmentId, executionState, cloid, orderSize, limitPx, reduceOnly]) =>
    ({ id, tid: sourceFillId.split(":").at(-1), leg, coin, state, reason, executionKey, leaderTime: Number(leaderTime), receivedAt: Number(receivedAt), sentAt: Number(sentAt), adjustmentId, executionState, cloid, orderSize, limitPx, reduceOnly: reduceOnly === 'true' }));
// The account's reduce-only closes that are not copy legs: a stop's or the owner's single-position close.
const closeCloids = new Set((await query(`select lower(e.cloid) from copy_live_executions e where lower(e.account_address) = ${quote(follower)} and e.network = ${quote(net)}
  and (e.record->'action'->'orders'->0->>'r')::boolean and not exists (select 1 from copy_live_dispatches d where d.execution_key = e.key)`)).map(([cloid]) => cloid));

// F — follower fills.
const followerFills = (await info(net, { type: "userFillsByTime", user: follower, startTime: since })).filter((f) => !f.coin.startsWith("@"));

// C — both accounts' positions; the follower's leverage per coin it traded or holds; szDecimals.
const [leaderState, followerState, meta] = await Promise.all([info(leaderNet, { type: "clearinghouseState", user: leader }), info(net, { type: "clearinghouseState", user: follower }), info(net, { type: "meta" })]);
const sizes = (state) => new Map(state.assetPositions.map((a) => [a.position.coin, Number(a.position.szi)]));
const L = sizes(leaderState), C = sizes(followerState);
const szDecimals = new Map(meta.universe.map((u) => [u.name, u.szDecimals]));
const followerLeverage = new Map();
for (const coin of new Set([...followerFills.map((f) => f.coin), ...C.keys()].filter((c) => !c.includes(":")))) {
  const data = await info(net, { type: "activeAssetData", user: follower, coin });
  followerLeverage.set(coin, Number(data?.leverage?.value ?? 0));
}

// The rules (checks.mjs).
const evaluated = evaluate({ leaderFills, dispatches: db === "none" ? null : dispatches, followerFills, leaderPositions: L, followerPositions: C, followerLeverage, szDecimals, rules, closeCloids });
for (const f of evaluated.failures) failures.push(f);
const { fillsByCloid } = evaluated;

// P — portfolio (its account snapshot) vs C.
let portfolio = null;
if (portfolioUrl) {
  if (!process.env.HARNESS_BEARER) fail("portfolio_unchecked", { reason: "HARNESS_BEARER is not set" });
  else {
    const get = async (url) => { const r = await fetch(url, { headers: { authorization: `Bearer ${process.env.HARNESS_BEARER}`, accept: "application/json" } }); const body = await r.json().catch(() => null); return { status: r.status, body: body?.data ?? body }; };
    const list = await get(portfolioUrl);
    const item = (list.body?.items ?? []).find?.((i) => (i.accountAddress ?? "").toLowerCase() === follower);
    if (!item) fail("portfolio_missing_account", { status: list.status });
    else {
      const base = portfolioUrl.replace(/\/me\/copy\/live\/portfolio\/?$/, "");
      const snap = await get(`${base}/me/copy/execution-wallets/${encodeURIComponent(item.accountId)}/snapshot`);
      portfolio = { stage: item.stage, accountId: item.accountId, snapshotStatus: snap.body?.status ?? snap.status, freshness: snap.body?.freshness ?? null,
        equity: snap.body?.metrics?.perpEquity ?? null, positions: (snap.body?.positions ?? []).map((p) => ({ coin: p.coin, size: p.size })) };
      if (snap.body?.status !== "observed") fail("portfolio_snapshot_unavailable", { status: snap.status, reason: snap.body?.reason ?? null });
      else {
        const equity = Number(snap.body.metrics.perpEquity), actual = Number(followerState.marginSummary.accountValue);
        // Flat, the equity is still; with a position open it moves with the mark between the two reads.
        const tolerance = C.size && [...C.values()].some((v) => v !== 0) ? Math.max(0.5, actual * 0.01) : 0.01;
        if (!(Math.abs(equity - actual) <= tolerance)) fail("portfolio_equity_mismatch", { portfolio: equity, exchange: actual, tolerance, freshness: snap.body.freshness });
        const shown = new Map(snap.body.positions.map((p) => [p.coin, Number(p.size)]));
        for (const coin of new Set([...shown.keys(), ...C.keys()])) if ((shown.get(coin) ?? 0) !== (C.get(coin) ?? 0)) fail("portfolio_position_mismatch", { coin, portfolio: shown.get(coin) ?? 0, exchange: C.get(coin) ?? 0 });
      }
    }
  }
}

const received = dispatches.map((d) => (d.receivedAt - d.leaderTime) / 1000);
const sent = dispatches.filter((d) => d.sentAt > 0).map((d) => (d.sentAt - d.leaderTime) / 1000);
const filled = dispatches.map((d) => (fillsByCloid.get(d.cloid.toLowerCase()) ?? []).reduce((min, f) => Math.min(min, f.time), Infinity) - d.leaderTime)
  .filter(Number.isFinite).map((ms) => ms / 1000);
const reasons = {}; for (const d of dispatches) { const k = `${d.state}/${d.reason || "-"}`; reasons[k] = (reasons[k] ?? 0) + 1; }
const report = {
  window: { since: new Date(since).toISOString(), until: new Date().toISOString() },
  leader: { address: leader, network: leaderNet, orders: leaderOrders.size, fills: leaderFills.length, positions: Object.fromEntries(L) },
  follower: { address: follower, network: net, fills: followerFills.length, equity: followerState.marginSummary.accountValue, withdrawable: followerState.withdrawable, positions: Object.fromEntries(C),
    leverage: Object.fromEntries(followerLeverage) },
  rules: { allowedRefusals: rules.allowedRefusals.map((a) => (a.coin ? `${a.reason}:${a.coin}` : a.reason)), sizing: rules.sizing ?? "skipped (no --per-trade-usd)", maxLeverage: rules.maxLeverage ?? "skipped (no --max-leverage)" },
  dispatches: db === "none" ? { skipped: "--db none: the dispatch checks (1-4, 7) need Orbie's database" } : { count: dispatches.length, byStateReason: reasons },
  latencySeconds: { received: { p50: pct(received, 0.5), p95: pct(received, 0.95), max: pct(received, 1) }, sent: { p50: pct(sent, 0.5), p95: pct(sent, 0.95), max: pct(sent, 1) },
    filled: { p50: pct(filled, 0.5), p95: pct(filled, 0.95), max: pct(filled, 1) } },
  portfolio,
  failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
