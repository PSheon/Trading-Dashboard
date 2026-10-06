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
// Checks (each failure is listed; exit 1 when any fails):
//   1. every leader order after --since has a dispatch row (or is merged into one), none silently missing;
//   2. no dispatch is refused for signal age (signal_expired / merged_signal_expired);
//   3. every dispatch with an execution has follower fills on the same side;
//   4. the follower's position per coin has the leader's direction (flat when the leader is flat);
//   5. the portfolio's positions and equity equal C (when P is given);
//   plus latency: received − leader and sent − leader, p50/p95/max.
//
// Usage (from the repo root):
//   node scripts/copy-harness/reconcile.mjs --leader 0x… --leader-network testnet \
//     --follower 0x… --network testnet --since 2026-10-07T01:00:00Z \
//     --db ssh|env|<postgres url> [--portfolio-url https://…/api/hl/me/copy/live/portfolio]
// `--db env` reads the URL from HARNESS_DATABASE_URL (so it never shows in `ps`).
// The portfolio needs HARNESS_BEARER (the follower's Privy access token) in the environment;
// the portfolio holds no balances, so P is the copy's account snapshot
// (GET …/me/copy/execution-wallets/:id/snapshot, the figures the portfolio page shows).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const leader = flag("leader")?.toLowerCase(), follower = flag("follower")?.toLowerCase();
const leaderNet = flag("leader-network", "mainnet"), net = flag("network", "testnet");
const since = Date.parse(flag("since", ""));
const db = flag("db", "ssh"), portfolioUrl = flag("portfolio-url");
if (!/^0x[0-9a-f]{40}$/.test(leader ?? "") || !/^0x[0-9a-f]{40}$/.test(follower ?? "") || !Number.isFinite(since)) {
  console.error("usage: --leader 0x… --follower 0x… --since <ISO> [--leader-network mainnet|testnet] [--network testnet|mainnet] [--db ssh|<url>]");
  process.exit(2);
}
const INFO = { mainnet: "https://api.hyperliquid.xyz/info", testnet: "https://api.hyperliquid-testnet.xyz/info" };
const info = async (network, body) => { const r = await fetch(INFO[network], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${network} ${body.type} ${r.status}`); return r.json(); };

// Orbie's rows: over SSH to the Stage Postgres (read-only), or a local database URL.
const SSH = ["-o", "BatchMode=yes", "-i", `${process.env.HOME}/.ssh/id_ed25519`, "25866604-3d9a-40cf-a29a-f680c43b8235@ssh.railway.com"];
async function query(sql) {
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

// L — leader orders after `since` (perp only).
const leaderFills = (await info(leaderNet, { type: "userFillsByTime", user: leader, startTime: since })).filter((f) => !f.coin.startsWith("@") && !f.coin.includes(":"));
const leaderOrders = new Map();
for (const f of leaderFills) { const o = leaderOrders.get(f.oid) ?? { oid: f.oid, coin: f.coin, side: f.side, time: f.time, tids: [] }; o.tids.push(String(f.tid)); leaderOrders.set(f.oid, o); }

// D — dispatches of copies of this leader into this follower account.
const dispatches = (await query(`select d.id, d.source_fill_id, d.leg, d.coin, d.state, coalesce(d.reason,''), coalesce(d.execution_key,''),
  extract(epoch from d.leader_time)*1000, extract(epoch from d.received_at)*1000, coalesce(extract(epoch from d.sent_at)*1000,0), coalesce(d.adjustment_id,''), coalesce(e.state,''), coalesce(e.cloid,'')
  from copy_live_dispatches d join copy_live_mandates m on m.id = d.mandate_id left join copy_live_executions e on e.key = d.execution_key
  where lower(m.leader_address) = ${quote(leader)} and lower(m.account_address) = ${quote(follower)} and d.leader_time >= to_timestamp(${since / 1000})`))
  .map(([id, sourceFillId, leg, coin, state, reason, executionKey, leaderTime, receivedAt, sentAt, adjustmentId, executionState, cloid]) =>
    ({ id, tid: sourceFillId.split(":").at(-1), leg, coin, state, reason, executionKey, leaderTime: Number(leaderTime), receivedAt: Number(receivedAt), sentAt: Number(sentAt), adjustmentId, executionState, cloid }));
const byTid = new Map(dispatches.map((d) => [d.tid, d]));

// 1. every leader order has a dispatch for at least one of its fills.
for (const o of leaderOrders.values()) if (!o.tids.some((tid) => byTid.has(tid))) fail("leader_order_without_dispatch", { oid: o.oid, coin: o.coin, side: o.side, at: new Date(o.time).toISOString() });
// 2. nothing lost to signal age.
for (const d of dispatches) if (/signal_expired/.test(d.reason)) fail("signal_expired", { dispatch: d.id, reason: d.reason });

// F — follower fills, by cloid.
const followerFills = (await info(net, { type: "userFillsByTime", user: follower, startTime: since })).filter((f) => !f.coin.startsWith("@"));
const fillsByCloid = new Map();
for (const f of followerFills) if (f.cloid) fillsByCloid.set(f.cloid.toLowerCase(), [...(fillsByCloid.get(f.cloid.toLowerCase()) ?? []), f]);
// 3. an executed dispatch has follower fills on the leader's side.
for (const d of dispatches.filter((x) => x.cloid && ["filled", "settled", "partially_filled"].includes(x.executionState) || x.state === "settled")) {
  const fills = fillsByCloid.get(d.cloid.toLowerCase()) ?? [];
  if (!fills.length) { fail("executed_without_follower_fill", { dispatch: d.id, cloid: d.cloid, executionState: d.executionState }); continue; }
  const lead = leaderFills.find((f) => String(f.tid) === d.tid);
  if (lead && d.leg === "open" && fills.some((f) => f.side !== lead.side)) fail("follower_side_mismatch", { dispatch: d.id, leader: lead.side, follower: fills.map((f) => f.side) });
}

// C — follower state; 4. direction per coin follows the leader's.
const [leaderState, followerState] = await Promise.all([info(leaderNet, { type: "clearinghouseState", user: leader }), info(net, { type: "clearinghouseState", user: follower })]);
const sizes = (state) => new Map(state.assetPositions.map((a) => [a.position.coin, Number(a.position.szi)]));
const L = sizes(leaderState), C = sizes(followerState);
for (const coin of new Set([...L.keys(), ...C.keys()])) {
  const l = Math.sign(L.get(coin) ?? 0), c = Math.sign(C.get(coin) ?? 0);
  if (dispatches.some((d) => d.coin === coin) && l !== c) fail("direction_mismatch", { coin, leader: L.get(coin) ?? 0, follower: C.get(coin) ?? 0 });
}

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
const reasons = {}; for (const d of dispatches) { const k = `${d.state}/${d.reason || "-"}`; reasons[k] = (reasons[k] ?? 0) + 1; }
const report = {
  window: { since: new Date(since).toISOString(), until: new Date().toISOString() },
  leader: { address: leader, network: leaderNet, orders: leaderOrders.size, fills: leaderFills.length, positions: Object.fromEntries(L) },
  follower: { address: follower, network: net, fills: followerFills.length, equity: followerState.marginSummary.accountValue, withdrawable: followerState.withdrawable, positions: Object.fromEntries(C) },
  dispatches: { count: dispatches.length, byStateReason: reasons },
  latencySeconds: { received: { p50: pct(received, 0.5), p95: pct(received, 0.95), max: pct(received, 1) }, sent: { p50: pct(sent, 0.5), p95: pct(sent, 0.95), max: pct(sent, 1) } },
  portfolio,
  failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
