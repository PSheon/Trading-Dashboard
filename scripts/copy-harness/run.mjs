#!/usr/bin/env node
// Copy harness — the whole loop against the local stack, in one command.
//
//   node scripts/copy-harness/run.mjs [--dry-run] [--headed] [--gap 20] [--scenarios base,3,4,…]
//        [--profile default|stage-caps|ratio-floor|stage-like] [--web http://localhost:3000] [--api http://localhost:3100] [--worker http://localhost:3010]
//        [--leader 0x… --watch-min 15] [--contention] [--worker-log .claude/logs/worker-3010.log] [--evidence-max-ms 3500]
//        [--measure-workers http://localhost:3010,…] [--mainnet-dexes 11] [--roles split --worker-read http://localhost:3011]
//
// --roles split: the stack runs a copy-role worker (3010) and a read worker (3011), as Stage does
// (stack.mjs restart worker|worker-read --roles split): the stack check wants both heartbeats' roles,
// the worker-restart scenario restarts the copy worker as `copy`, and the read worker's heartbeat is
// measured too. Without it the one all-role worker is accepted and the report says so beside the
// local-bucket waits (TradeAnalytics / Cohort / Leaderboard reads drain the same bucket as orders).
//
// Before a scenario's reconcile and before the final stop the harness waits (lib.mjs waitForInFlight:
// up to the risk policy's signal-age limit plus 30 s, 150 s at most) while a leg of the copy is still
// in flight — a dispatch `submitted`, or `pending` with a running attempt (first_attempt_at) or a
// retry due — so a legitimate attempt is neither judged missing nor cut by the stop (gate 13's flip:
// the window closed 36 s after the leader's last order on a pending attempt, then the stop produced a
// misleading live_risk_mandate_changed). Logged as scenario_wait_in_flight {dispatches, waitedMs}.
//
// 1. leader and follower balances: too little stops the run (exit 3) before anything is signed;
// 2. cleanup: running copies of the harness leader are stopped, waiting setups cancelled, the leader flattened;
// 3. the leader sends 150 testnet USDC to the follower's main wallet (only when it holds < the budget);
// 4. a one-click copy of the leader (testnet source, fixed 12 USDC per trade, the profile's budget): the setup
//    is prepared through the api, and the browser (the Privy test account on the local web) confirms it from
//    the portfolio's 繼續設定 — it signs the consent and the deposit and calls addSigners; 5. wait for running;
// 6. the scenarios (lib.mjs SCENARIOS; a scenario that stops the copy makes the next one start a new copy):
//    base   (1) leader.mjs scenario, reconcile, withdraw 10 idle USDC, stop with the return credited;
//    reduce-min (3) reduce 25 % of a 48 USD leader position; follower leg under 10; then close;
//    stop-open (4) stop while a position is open: flat, the automatic return credited, shown stopped;
//    close-then-stop (6) the owner's single-position close, then a stop within 2 s: never blocked, flat, stopped;
//    worker-restart (7) `stack.mjs restart worker` between a leader trade and its fill: no double send, later legs trade;
//    refused-open (8) an open refused under the order minimum, then later legs (a close included) execute;
//    burst (9) the leader closes in 3 fills within 20 s: the follower ends flat;
//    kill-switch (14) platform pause (opens refused, reductions mirrored), then admin close-all closes and returns;
//    new-coin (21) BTC, then a first ETH and SOL open, each settled, then closes; add-reduce (22) open, add,
//    partial reduce, close; merged (23) opens and reductions 3 s apart (merged legs); flip (24) long → short in one fill;
//    gate: new-coin, add-reduce, merged, flip, stop-open (the pre-mainnet gate; see README.md);
//    each reconciled by reconcile.mjs with the profile's rules (fixed size, leverage cap, refusal allowlist, flat),
//    and each order's evidence read from the worker's live_execution_timing lines (--worker-log, default
//    .claude/logs/worker-3010.log): under --evidence-max-ms (3500), and no attempt failed live_risk_stale or
//    a generation proof (lib.mjs EVIDENCE_FAILURES). A testnet order is judged without its dex fan-out (the
//    run's testnet perpDexs count; criteria.mjs dexFanout), a mainnet order on its raw evidence; both shown,
//    with the fan-out's ms/dex and a projection to --mainnet-dexes (11) mainnet venues. Each scenario is
//    judged on its own checks (criteria.mjs classifyScenario): a latency criterion miss (judged evidence at or
//    over the limit, no money effect) is recorded as FAIL and the gate goes on; only a failure that makes
//    continuing unsafe (a leader leg, a mirror, the reconcile, a stop, the follower not flat) aborts the rest;
// 7. a copy still running at the end is stopped; a summary table (pass/fail per check, latency p50/p95),
//    then one line per scenario: pass/fail, its orders' evidence p50/p95/max, criterion misses, trip-wire
//    hits (legs lost to evidence age; evidence-age failures over 5 % of the run's attempts) and its dispatch
//    created → sent latency; the verdict block (`gate: PASS`, or `gate: FAIL (criterion miss: n scenarios;
//    trip-wire hits: m)`, with the testnet note when the window in force is not 5000); then the MEASUREMENTS block
//    (measure.mjs; recorded, never pass/fail): the POST round trip, close and leg attempts, the delay after a
//    failed attempt, the signer's wallet check age, the workers' foreignUsage / publicIps at start and end
//    (--measure-workers, default --worker) and the rate-limit lines, the setups' claim waits.
//
// --contention runs contention.mjs beside the scenarios: the orders' meter background lane kept full, as on Stage.
//
// --dry-run needs no funds: login, cleanup, the setup up to its consent challenge, the browser's two
// signatures and addSigners (its /confirm is intercepted, so nothing is deposited; with an empty main
// wallet the real /confirm goes out and must be refused 409 insufficient_main_balance), then cancel;
// and each scenario's leader legs planned from live markets (leader.mjs --dry-run, nothing signed).
//
// The local api and worker must run with COPY_TRADING_MODE=testnet: `node scripts/copy-harness/stack.mjs
// restart worker` (and `api`) starts them with the harness profile (harness.env: testnet mode, the
// 3 s testnet source); add `--profile stage-caps` to both (and to run.mjs) for Stage's caps.
// kill-switch needs an admin bearer with execution.pause/resume: HARNESS_ADMIN_TOKEN, else the
// api's AUTH_SERVICE_TOKEN from .env. Secrets (.env, the leader's key) stay in their processes.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SIGNAL_AGE_LIMIT_MS, EVIDENCE_FAILURES, EVIDENCE_MAX_MS, EXIT, evidenceWindowLabel, evidenceWindowMs, GATE_SCENARIOS, HARNESS_LEADER, ROOT, SCENARIOS, evidenceStats, fundingGate, inFlightSql, inFlightWaitMs, lastStartRtt, loadEnv, parseScenarios, parseStuckRows, planCleanup, profileEnv,
  renderGateSummary, renderSpans, renderSummary, scanWorkerLog, stopSettled, stuckRowsSql, termsFor, waitFor, waitForInFlight, zeroCodeCounts } from "./lib.mjs";
import { apiClient, confirmFromPortfolio, launch, login } from "./follower.mjs";
import { MAINNET_DEXES, classifyScenario, evidenceDetail, judgeOrders, judgedStats, renderGateVerdict, tripWires } from "./criteria.mjs";
import { attemptDelays, claimWaitSummary, dispatchMeasures, heartbeatDeltas, heartbeatReading, measureSql, renderMeasurements, scanMeasureLog, workerRolesLabel } from "./measure.mjs";
import { WORKER_ROLES_MODES } from "./stack-plan.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(`--${name}`);
const WEB = flag("web", "http://localhost:3000"), API = flag("api", "http://localhost:3100"), WORKER = flag("worker", "http://localhost:3010");
const DRY = has("dry-run"), GAP = flag("gap", "20");
// --leader 0x…: copy that real mainnet trader (a mainnet source on this testnet stack) instead of the scripted testnet leader.
const LEADER = (flag("leader") ?? HARNESS_LEADER).toLowerCase(), SOURCE = flag("leader") ? "mainnet" : "testnet", WATCH_MIN = Number(flag("watch-min", "15"));
let SCENARIO_LIST, TERMS;
try { SCENARIO_LIST = parseScenarios(flag("scenarios")); TERMS = termsFor(flag("profile", "default")); }
catch (error) { console.error(error.message); process.exit(EXIT.usage); }
const WORKER_LOG = resolve(flag("worker-log", resolve(ROOT, ".claude/logs/worker-3010.log")));
const EVIDENCE_MAX = Number(flag("evidence-max-ms", String(EVIDENCE_MAX_MS)));
if (!(EVIDENCE_MAX > 0)) { console.error("--evidence-max-ms: a positive number of ms"); process.exit(EXIT.usage); }
// The api's evidence window under this profile (stage-like: the testnet 7000; else 5000), beside every evidence figure.
const EVIDENCE_WINDOW = evidenceWindowMs(profileEnv(TERMS.profile));
const MAINNET_DEX_COUNT = Number(flag("mainnet-dexes", String(MAINNET_DEXES)));
if (!Number.isSafeInteger(MAINNET_DEX_COUNT) || MAINNET_DEX_COUNT < 1) { console.error("--mainnet-dexes: a positive integer (perpDexs entries, the main dex included)"); process.exit(EXIT.usage); }
// --roles split: a copy worker (--worker) and a read worker (--worker-read), as on Stage; else one all-role worker.
const ROLES = flag("roles", "all"), WORKER_READ = flag("worker-read", "http://localhost:3011").replace(/\/+$/, "");
if (!WORKER_ROLES_MODES.includes(ROLES)) { console.error(`--roles: ${WORKER_ROLES_MODES.join(" | ")}`); process.exit(EXIT.usage); }
const SPLIT = ROLES === "split";
const MEASURE_WORKERS = [...new Set([...flag("measure-workers", WORKER).split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean), ...(SPLIT ? [WORKER_READ] : [])])];
const OUT = resolve(ROOT, ".claude/logs/copy-harness"); mkdirSync(OUT, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); log("check", { name, ok, detail }); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helpers -------------------------------------------------------------------------------
const INFO = "https://api.hyperliquid-testnet.xyz/info";
const info = async (body) => { const r = await fetch(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`testnet ${body.type} ${r.status}`); return r.json(); };
/** USDC a wallet can move: the perp withdrawable plus free spot USDC. */
async function usdc(address) {
  const [perp, spot] = await Promise.all([info({ type: "clearinghouseState", user: address }), info({ type: "spotClearinghouseState", user: address })]);
  const s = spot.balances.find((b) => b.coin === "USDC");
  return { perp: Number(perp.withdrawable), spot: s ? Number(s.total) - Number(s.hold) : 0, total: Number(perp.withdrawable) + (s ? Number(s.total) - Number(s.hold) : 0),
    positions: perp.assetPositions.map((a) => ({ coin: a.position.coin, szi: Number(a.position.szi) })).filter((p) => p.szi !== 0), equity: Number(perp.marginSummary.accountValue) };
}
/** A child node script; its JSON lines are parsed, stdout echoed. */
function node(script, scriptArgs, { env = {}, quiet = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, script), ...scriptArgs], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on("data", (d) => { err += d; process.stderr.write(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      const lines = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolveRun({ code, out, err, lines });
    });
  });
}
async function leaderState() {
  const r = await node("leader.mjs", ["state"], { quiet: true });
  const state = r.lines.find((l) => l.event === "state");
  if (r.code !== 0 || !state) throw new Error(`leader.mjs state failed: ${r.err.trim().split("\n").at(-1)}`);
  return state;
}
/** The worker log's size now (null: no log), and the text appended after `offset` (the last 16 MB at most). */
function logSize() { try { return statSync(WORKER_LOG).size; } catch { return null; } }
function readLogFrom(offset) {
  const fd = openSync(WORKER_LOG, "r");
  try {
    const size = fstatSync(fd).size, from = Math.max(size < offset ? 0 : offset, size - 16 * 2 ** 20), buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    return buffer.toString("utf8");
  } finally { closeSync(fd); }
}
/** Each measured worker's /health heartbeat (foreignUsage, egressIdentity), as measure.mjs reads it. */
async function heartbeats() {
  return Promise.all(MEASURE_WORKERS.map(async (url) => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { url, error: `/health ${r.status}` };
      return heartbeatReading(url, await r.json());
    } catch (error) { return { url, error: `/health unreachable (${error.name})` }; }
  }));
}
/** The testnet perp venues every order's observation subscribes (perpDexs entries, the main dex
 * included), read once per run from the testnet info API; null when it can't be read (raw evidence is judged). */
let testnetDexes;
async function testnetVenues() {
  if (testnetDexes === undefined) {
    try { const list = await info({ type: "perpDexs" }); testnetDexes = Array.isArray(list) && list.length ? { venues: list.length, at: new Date().toISOString(), source: "testnet info perpDexs" } : null; }
    catch (error) { log("perp_dexs_unread", { error: error.message }); testnetDexes = null; }
  }
  return testnetDexes;
}
async function health(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.status < 500; } catch { return false; } }

const env = loadEnv();
let browser = null, follower = null, setupId = null;
/** One row per scenario (the gate's table): pass/fail, its orders' evidence, its class (criteria.mjs
 * classifyScenario: criterion miss, trip-wire) and its dispatch created → sent latency. */
const scenarioRows = [];
/** The run's worker-log slice over every scenario (the trip-wire's 5 % rule is a run figure), and the
 * scenario whose failure stopped the gate (null: every scenario ran). */
const gateRun = { failures: [], refusals: [], orders: [], abortedAfter: null, abortedBy: [] };
/** contention.mjs while the scenarios run (--contention), and its latest counts. */
let contention = null;
/** The measurements' inputs: the run's start (worker log offset), the workers' first heartbeats, the
 * copies' strategies and each setup's stages as polled (the claim waits' steps). */
const measureRun = { at: Date.now(), offset: null, heartbeats: null, strategyIds: new Set(), setupStages: [] };
/** The measurements block (measure.mjs) over the run so far; its inputs also go to <run>-measurements.json. */
async function measurements() {
  const to = Date.now(), m = { window: { from: new Date(measureRun.at).toISOString(), to: new Date(to).toISOString() }, log: null, db: null, delays: null, health: null, claims: null };
  let dispatches = [];
  if (measureRun.strategyIds.size) {
    const sql = measureSql({ strategyIds: [...measureRun.strategyIds], since: new Date(measureRun.at - 1000).toISOString() });
    // psql's own errors can name the database host: never printed, only its exit code.
    const result = await new Promise((resolveOut) => {
      const child = spawn("psql", [env.DATABASE_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: ["ignore", "pipe", "ignore"] });
      let text = ""; child.stdout.on("data", (d) => { text += d; });
      child.on("error", () => resolveOut({ code: -1, text })); child.on("close", (code) => resolveOut({ code, text }));
    });
    try {
      if (result.code !== 0) throw new Error(`psql exit ${result.code}`);
      const rows = JSON.parse(result.text.trim());
      dispatches = rows.dispatches;
      m.db = dispatchMeasures(rows.dispatches, rows.cloids);
    } catch (error) { m.dbNote = `not read (${error.message.slice(0, 80)})`; }
  } else m.dbNote = "no copy ran in this run";
  const size = logSize();
  if (size === null) m.logNote = `no worker log at ${WORKER_LOG}`;
  else {
    const from = measureRun.offset ?? 0;
    if (size - from > 16 * 2 ** 20) m.logNote = "the run wrote over 16 MB of worker log: only its last 16 MB were read";
    m.log = scanMeasureLog(readLogFrom(from), { since: measureRun.at - 1000, until: to });
    m.delays = attemptDelays(m.log.failures, { budgetWaits: m.log.budgetWaits, dispatches });
    m.claims = claimWaitSummary(m.log.claimWaits, measureRun.setupStages);
  }
  if (measureRun.heartbeats) m.health = heartbeatDeltas(measureRun.heartbeats, await heartbeats());
  else m.healthNote = "no start reading (the run ended before it)";
  // The worker roles the run measured: the local-bucket waits of an all-role worker include the read work's.
  m.roles = workerRolesLabel(measureRun.heartbeats ?? [], { copy: WORKER, read: SPLIT ? WORKER_READ : null });
  writeFileSync(resolve(OUT, `${runId}-measurements.json`), `${JSON.stringify({ ...m, setupStages: measureRun.setupStages }, null, 2)}\n`);
  return renderMeasurements(m) + (m.logNote && m.log ? `\n(${m.logNote})` : "");
}
const summary = (extra = {}, measured = null) => {
  // The gate table, then its verdict block (the two classes, the abort, the testnet note, `gate: PASS|FAIL …`);
  // the verdict line is repeated as the summary's last line.
  const verdict = scenarioRows.length ? renderGateVerdict(scenarioRows, { maxMs: EVIDENCE_MAX, windowMs: EVIDENCE_WINDOW, run: tripWires(gateRun),
    abortedAfter: gateRun.abortedAfter, abortedBy: gateRun.abortedBy, venues: testnetDexes?.venues ?? null }) : null;
  const text = renderSummary({ checks, mode: DRY ? "dry run" : "full", ...extra }) +
    (verdict ? `\n\n${renderGateSummary(scenarioRows, EVIDENCE_MAX, EVIDENCE_WINDOW)}\n\n${verdict}\n\n${renderSpans(scenarioRows)}` : "") +
    (measured ? `\n\n${measured}` : "") +
    (verdict ? `\n\n${verdict.split("\n").at(-1)}` : "");
  console.log(`\n${text}\n`);
  writeFileSync(SUMMARY, `${text}\n`);
  log("summary_written", { path: SUMMARY });
};
const SUMMARY = resolve(OUT, `${runId}-summary.txt`);
const finish = async (code, extra) => {
  if (contention) {
    contention.child.kill("SIGTERM");
    const c = contention.counts;
    check("contention_background_lane_full", contention.exited ? false : c ? c.refused > 0 : null,
      c ? `background asks granted ${c.granted}, refused ${c.refused} (lane full), errors ${c.errors}; sockets ${c.sockets}, refused ${c.socketRefused}` : "no counts yet");
    contention = null;
  }
  let measured;
  try { measured = await measurements(); } catch (error) { measured = `MEASUREMENTS not recorded: ${error.name}: ${error.message.slice(0, 160)}`; }
  summary(extra, measured);
  // Only our isolated context is owned; preserve the shared Stage login.
  await follower?.context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  console.log(`summary: ${SUMMARY}`);
  process.exit(code === EXIT.green && checks.some((c) => c.ok === false) ? EXIT.failed : code);
};

try {
  measureRun.offset = logSize();
  // --- 0. the local stack --------------------------------------------------------------------
  for (const [name, url] of [["web", WEB], ["api", `${API}/health`], ["worker", `${WORKER}/health`]])
    if (!check(`stack_${name}_up`, await health(url), url)) await finish(EXIT.failed);
  // The worker runs with the profile's database round trip (stage-like: 8 ms), or the gate measures the wrong stack.
  {
    const expected = Number(profileEnv(TERMS.profile).COPY_HARNESS_DB_RTT_MS || 0);
    const actual = logSize() === null ? null : lastStartRtt(readLogFrom(0));
    const ok = actual === null ? (expected > 0 ? false : null) : actual === expected;
    if (false === check("stack_worker_db_rtt", ok, `worker's latest start: ${actual === null ? `unknown (no start in ${WORKER_LOG})` : `${actual} ms`}, profile ${TERMS.profile}: ${expected} ms` +
      (ok === false ? `; restart it: node scripts/copy-harness/stack.mjs restart worker${TERMS.profile === "default" ? "" : ` --profile ${TERMS.profile}`} (and api)` : ""))) await finish(EXIT.failed);
  }
  // The measurements' start: each worker's foreignUsage and public IPs (I-17).
  measureRun.heartbeats = await heartbeats();
  log("measure_start", { heartbeats: measureRun.heartbeats });
  // The worker roles (WORKER_ROLE, the heartbeat's worker.role): --roles split wants a copy worker on
  // --worker and a read worker on --worker-read, as on Stage; else the all-role worker is accepted and named.
  {
    const role = (url) => measureRun.heartbeats.find((h) => h.url === url)?.role ?? null;
    const copyRole = role(WORKER);
    if (SPLIT) {
      const readUp = await health(`${WORKER_READ}/health`), readRole = readUp ? (await heartbeats().then((hs) => hs.find((h) => h.url === WORKER_READ)?.role)) ?? null : null;
      if (!check("stack_worker_roles", copyRole === "copy" && readRole === "read", `--roles split: worker ${WORKER} role ${copyRole ?? "?"}, read worker ${WORKER_READ} ${readUp ? `role ${readRole ?? "?"}` : "not up"}` +
        (copyRole === "copy" && readRole === "read" ? "" : `; restart them: node scripts/copy-harness/stack.mjs restart worker --roles split${TERMS.profile === "default" ? "" : ` --profile ${TERMS.profile}`}, then restart worker-read (same flags), and api --roles split`))) await finish(EXIT.failed);
    } else check("stack_worker_roles", null, `${copyRole === "all" ? "all-role worker" : `worker role ${copyRole ?? "?"}`} on ${WORKER} (roles not split; --roles split runs a copy and a read worker as on Stage)`);
  }

  // --- 1. balances -----------------------------------------------------------------------------
  const leader = await leaderState();
  const leaderFree = Number(leader.withdrawable);
  log("leader", { address: leader.address, equity: leader.equity, withdrawable: leader.withdrawable, positions: leader.positions });

  // --- 2. the follower logs in ---------------------------------------------------------------------
  browser = await launch({ headless: !has("headed") });
  follower = await login(browser, { web: WEB, api: API, env, log });
  const main = follower.me.walletAddress;
  check("follower_login", true, `user ${follower.me.id}, main wallet ${main}`);
  const overview = await follower.client.get("/me/copy/live");
  // Testnet only: a stack whose copies run on mainnet is refused before anything is prepared.
  if (!check("api_testnet_mode", overview.network === "testnet" && overview.capabilities.automaticExecution && overview.capabilities.sourceNetworks.includes("testnet") && overview.capabilities.actualAllowed !== false,
    `network=${overview.network}, automaticExecution=${overview.capabilities.automaticExecution}, sources=${overview.capabilities.sourceNetworks.join(",")}, actualAllowed=${overview.capabilities.actualAllowed ?? "n/a"}`)) await finish(EXIT.failed);
  // --- 2b. cleanup (idempotent rerun), before the funding check: a stopped
  // copy's return reaches the follower's main wallet first (a run cut short
  // left 49 USDC in its copy account, 2026-10-12) ----------------------------------------------
  const portfolio = async () => (await follower.client.get("/me/copy/live/portfolio")).items;
  const actions = planCleanup(await portfolio());
  log("cleanup_plan", { actions });
  for (const a of actions) {
    if (a.kind === "cancel_setup") await follower.client.post(`/me/copy/live/setups/${a.setupId}/cancel`).catch((e) => log("cleanup_cancel_failed", { setupId: a.setupId, error: e.message }));
    if (a.kind === "stop") await follower.client.post(`/me/copy/live/mandates/${a.mandateId}/stop`, { idempotencyKey: `harness-cleanup-${randomUUID()}`, expectedMandateRevision: a.revision });
    if (a.kind === "return_all") {
      try {
        const reserved = await follower.client.post(`/me/copy/live/execution-wallets/${a.accountId}/returns`, { idempotencyKey: randomUUID(), amount: "all" });
        const op = reserved.operation ?? reserved;
        await follower.client.post(`/me/copy/live/returns/${op.id}/approve`);
        log("cleanup_return_all", { strategyId: a.strategyId, accountId: a.accountId, operationId: op.id });
      } catch (e) {
        // Not waited on: a refused return never settles.
        log("cleanup_return_failed", { strategyId: a.strategyId, accountId: a.accountId, error: e.message });
        check("cleanup_previous_copies", false, `return of a failed start's funds (strategy ${a.strategyId}) refused: ${e.message}`);
        await finish(EXIT.failed);
      }
    }
    if (a.kind === "await_setup") log("cleanup_setup_in_progress", { setupId: a.setupId, note: "a confirmed setup can't be cancelled; it is stopped once it runs" });
  }
  if (actions.some((a) => a.kind === "stop" || a.kind === "await_stop" || a.kind === "await_setup" || a.kind === "return_all")) {
    const settled = await waitFor(portfolio, (items) => planCleanup(items).every((a) => a.kind === "cancel_setup" || a.kind === "return_all") && items.filter((i) => i.leaderAddress === HARNESS_LEADER).every((i) => i.stage === "stopped" ? stopSettled(i) : !["starting", "active", "paused", "stopping", "sweeping"].includes(i.stage)),
      { timeoutMs: 600_000, intervalMs: 5000 });
    if (!check("cleanup_previous_copies", settled.ok, settled.ok ? `${actions.length} action(s)` : "a previous copy did not settle in 10 min")) await finish(EXIT.failed);
  } else check("cleanup_previous_copies", true, actions.length ? `${actions.length} setup(s) cancelled` : "nothing to clean");
  const mainBefore = await usdc(main);
  log("follower_main", { address: main, perp: mainBefore.perp, spot: mainBefore.spot });
  const gate = fundingGate({ leader: leaderFree, follower: mainBefore.total, terms: SOURCE === "mainnet" ? { ...TERMS, leaderScenarioUsd: 0 } : TERMS });
  if (!gate.ok) {
    const spotHint = Number(leader.spotUsdc) > 0 ? ` The leader holds ${Number(leader.spotUsdc).toFixed(2)} USDC in spot: move it to perps first (usdClassTransfer).` : "";
    const message = `NOT FUNDED — ${gate.problems.join("; ")}. Fund the harness leader's perp account with testnet USDC (Hyperliquid testnet faucet, or a usdSend from a funded testnet wallet), then rerun.${spotHint}`;
    if (!DRY) { check("funded", false, message); console.error(`\n${message}\n`); await finish(EXIT.unfunded); }
    check("funded", null, `dry run continues without funds: ${gate.problems.join("; ")}`);
  } else check("funded", true, `leader ${leaderFree.toFixed(2)}, follower main ${mainBefore.total.toFixed(2)}${gate.send ? `, will send ${gate.sendUsd}` : ""}`);

  if (leader.positions.length) {
    if (DRY) check("leader_flat", null, `leader holds ${JSON.stringify(leader.positions)} (dry run leaves it)`);
    else { const r = await node("leader.mjs", ["flatten"]); check("leader_flat", r.code === 0, "closed the leader's leftover positions"); }
  }

  // --- 3. the leader funds the follower ------------------------------------------------------------
  if (!DRY && gate.send) {
    const r = await node("leader.mjs", ["send", main, String(gate.sendUsd)]);
    const credited = await waitFor(() => usdc(main), (b) => b.total >= mainBefore.total + gate.sendUsd - 1, { timeoutMs: 90_000, intervalMs: 3000 });
    if (!check("leader_sent_150", r.code === 0 && credited.ok, `main wallet ${mainBefore.total.toFixed(2)} → ${credited.value.total.toFixed(2)}`)) await finish(EXIT.failed);
  } else if (!DRY) check("leader_sent_150", null, `not needed: main wallet holds ${mainBefore.total.toFixed(2)}`);

  // --- 4–5. a running one-click copy ------------------------------------------------------------------
  const ratio = TERMS.sizingMode === "ratio";
  const settings = { direction: "same", sizingMode: ratio ? "ratio" : "fixed", perTradeUsd: ratio ? null : TERMS.perTradeUsd, maxTotalExposureUsd: null, maxLeverage: TERMS.maxLeverage, copyStartMode: "delta" };
  /** Prepares a copy, confirms it in the browser and waits until it runs. Dry run: stops after the consent. */
  async function startCopy(label) {
    const startBody = { idempotencyKey: `harness-${randomUUID()}`, leader: LEADER, sourceNetwork: SOURCE, budgetUsd: String(TERMS.budgetUsd), settings };
    const prepared = await waitFor(() => follower.client.post("/me/copy/live/setups", startBody), (s) => s.stage !== "provisioning", { timeoutMs: 60_000, intervalMs: 2000 });
    const setup = prepared.value;
    setupId = setup.id;
    measureRun.setupStages.push({ setupId: setup.id, at: Date.now(), stage: setup.stage });
    const consent = setup.consent;
    if (!check(`${label}_setup_prepared`, prepared.ok && setup.stage === "awaiting_consent" && consent?.sourceNetwork === SOURCE && consent?.leaderAddress === LEADER &&
        consent?.budgetUsd === String(TERMS.budgetUsd) && consent?.fundingAmount === String(TERMS.budgetUsd) && Boolean(consent?.masterPolicyId && consent?.workerQuorumId),
      `setup ${setup.id} ${setup.stage}${setup.issue ? ` (${setup.issue})` : ""}, source ${consent?.sourceNetwork}, budget ${consent?.budgetUsd}, account ${consent?.accountAddress}`)) await finish(EXIT.failed);

    // A dry run never deposits: its /confirm is intercepted, except while the main wallet can't cover the
    // budget, when the real /confirm must be refused (409 insufficient_main_balance) with nothing sent.
    const unfundedConfirm = DRY && mainBefore.total < TERMS.budgetUsd;
    const confirmed = await confirmFromPortfolio(follower.page, { web: WEB, setupId, dryRun: DRY && !unfundedConfirm, log });
    log("browser_confirm", confirmed);
    check(`${label}_browser_signed_consent_and_deposit`, Boolean(confirmed.confirmRequest?.consentSignature && confirmed.confirmRequest?.fundingSignature),
      confirmed.confirmRequest ? `consent ${confirmed.confirmRequest.consentSignature}, deposit ${confirmed.confirmRequest.fundingSignature}` : `no /confirm sent (${confirmed.outcome}${confirmed.alert ? `: ${confirmed.alert}` : ""})`);
    // addSigners is Privy's wallet update (PATCH /api/v1/wallets/:id); /confirm leaves the browser only after it resolved.
    const signerUpdate = confirmed.privy.find((c) => /^PATCH \/api\/v1\/wallets\/:id 2\d\d$/.test(c));
    check(`${label}_browser_added_worker_signer`, Boolean(signerUpdate) && confirmed.confirmRequest?.setupId === setupId,
      `${signerUpdate ?? "no Privy wallet update"}; ${confirmed.outcome} after ${(confirmed.ms / 1000).toFixed(1)} s; privy: ${confirmed.privy.filter((c) => !c.includes("analytics")).join(", ")}`);

    if (DRY) {
      if (unfundedConfirm) check("dry_run_unfunded_confirm_refused", confirmed.confirmStatus === 409 && confirmed.confirmBody?.error?.code === "insufficient_main_balance",
        `${confirmed.confirmStatus} ${confirmed.confirmBody?.error?.code ?? confirmed.outcome}`);
      const cancelled = await follower.client.post(`/me/copy/live/setups/${setupId}/cancel`);
      check("dry_run_cancelled", cancelled.stage === "cancelled", `setup ${setupId} ${cancelled.stage}`);
      const after = await usdc(main);
      check("dry_run_nothing_deposited", Math.abs(after.total - mainBefore.total) < 1e-6, `main wallet ${mainBefore.total.toFixed(2)} → ${after.total.toFixed(2)}`);
      return null;
    }
    if (!check(`${label}_setup_confirmed`, confirmed.outcome === "confirmed", `${confirmed.outcome} ${confirmed.confirmStatus ?? ""} ${JSON.stringify(confirmed.confirmBody?.error ?? confirmed.confirmBody?.data?.stage ?? "").slice(0, 160)}`)) await finish(EXIT.failed);
    const t5 = Date.now();
    const running = await waitFor(() => follower.client.get(`/me/copy/live/setups/${setupId}`), (s) => ["running", "failed", "expired", "cancelled"].includes(s.stage),
      { timeoutMs: 600_000, intervalMs: 3000, onTick: (s) => { measureRun.setupStages.push({ setupId, at: Date.now(), stage: s.stage }); log("setup_stage", { stage: s.stage, issue: s.issue }); } });
    if (!check(`${label}_setup_running`, running.value.stage === "running", `${running.value.stage}${running.value.issue ? ` (${running.value.issue})` : ""} after ${((Date.now() - t5) / 1000).toFixed(0)} s`)) await finish(EXIT.failed);
    const strategyId = running.value.strategyId;
    if (Number.isSafeInteger(strategyId)) measureRun.strategyIds.add(strategyId);
    const item = async () => (await portfolio()).find((i) => i.strategyId === strategyId);
    const active = await waitFor(item, (i) => i?.stage === "active", { timeoutMs: 120_000, intervalMs: 3000 });
    if (!check(`${label}_portfolio_active`, active.ok, `strategy ${strategyId}, account ${active.value?.accountAddress}, stage ${active.value?.stage}`)) await finish(EXIT.failed);
    return { strategyId, account: active.value.accountAddress, accountId: active.value.accountId, item };
  }

  // --- helpers of the scenarios -----------------------------------------------------------------------------
  const leaderRun = async (label, leaderArgs) => {
    const r = await node("leader.mjs", leaderArgs);
    check(`${label}_leader`, r.code === 0, `${leaderArgs.join(" ")}: ${r.lines.filter((l) => l.event === "trade").length} order(s)${r.code ? `, ${r.err.trim().split("\n").at(-1)}` : ""}`);
    return r;
  };
  const followerHolds = (copy, coin) => waitFor(() => usdc(copy.account), (b) => b.positions.some((p) => p.coin === coin), { timeoutMs: 120_000, intervalMs: 3000 });
  let lastReconcile = null;
  /** The risk policy's signal-age limit (ms), read once from the api's admin risk policy (HARNESS_ADMIN_TOKEN /
   * AUTH_SERVICE_TOKEN); without one, or unreadable, the policy's default (lib.mjs DEFAULT_SIGNAL_AGE_LIMIT_MS). */
  let signalAgeLimit = null;
  async function signalAgeLimitMs() {
    if (signalAgeLimit === null) {
      signalAgeLimit = { ms: DEFAULT_SIGNAL_AGE_LIMIT_MS, source: "default (no admin token)" };
      if (admin) {
        try { const seconds = Number((await admin.get("/admin/copy/risk")).limits?.maxSignalAgeSeconds); if (seconds > 0) signalAgeLimit = { ms: seconds * 1000, source: "api /admin/copy/risk" }; }
        catch (error) { signalAgeLimit.source = `default (/admin/copy/risk: ${error.message.slice(0, 60)})`; }
      }
    }
    return signalAgeLimit;
  }
  /** The copies' legs not yet terminal (lib.mjs inFlightSql, psql on the stack's DATABASE_URL; psql's errors stay unprinted). */
  async function inFlightRows() {
    if (!measureRun.strategyIds.size) return [];
    const result = await new Promise((resolveOut) => {
      const child = spawn("psql", [env.DATABASE_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c", inFlightSql([...measureRun.strategyIds])], { stdio: ["ignore", "pipe", "ignore"] });
      let text = ""; child.stdout.on("data", (d) => { text += d; });
      child.on("error", () => resolveOut({ code: -1, text })); child.on("close", (code) => resolveOut({ code, text }));
    });
    if (result.code !== 0) throw new Error(`psql exit ${result.code}`);
    return JSON.parse(result.text.trim() || "[]");
  }
  /**
   * Before a scenario is judged (its reconcile) and before the final stop: wait while a leg of the copy
   * is in flight (lib.mjs waitForInFlight), up to the signal-age limit plus a margin (150 s at most).
   * Nothing in flight: no wait. Logged as scenario_wait_in_flight; a wait that gave up is a check failure
   * (a leg still pending after the limit is the engine's defect, not the harness's timing).
   */
  async function waitInFlight(label) {
    const limit = await signalAgeLimitMs(), waitMs = inFlightWaitMs(limit.ms);
    let waited;
    try { waited = await waitForInFlight(inFlightRows, { waitMs, intervalMs: 3000 }); }
    catch (error) { log("scenario_wait_in_flight", { scenario: label, error: error.message, waitMs }); return null; }
    log("scenario_wait_in_flight", { scenario: label, dispatches: waited.dispatches.map((d) => `${d.id} ${d.leg} ${d.coin} ${d.state}${d.reason ? `:${d.reason}` : ""} attempts ${d.attempts}${d.firstAttemptAt ? ` first ${d.firstAttemptAt}` : ""}`),
      waitedMs: waited.waitedMs, polls: waited.polls, left: waited.left.map((d) => d.id), waitMs, signalAgeLimitMs: limit.ms, limitSource: limit.source });
    if (waited.timedOut) check(`${label}_in_flight_settled`, false, `${waited.left.length} leg(s) still in flight after ${Math.round(waited.waitedMs / 1000)} s (limit ${limit.ms} ms + margin): ${waited.left.map((d) => `${d.id} ${d.leg} ${d.coin} ${d.state}${d.reason ? `:${d.reason}` : ""}`).join(", ")}`);
    return waited;
  }
  /** reconcile.mjs over [since, now] with the profile's rules, retried while the copy catches up. */
  async function reconcileCheck(label, copy, since, allow = []) {
    // A leg still in flight is waited for first: it is judged on its outcome, never on its timing.
    await waitInFlight(label);
    const reconcileArgs = ["--leader", HARNESS_LEADER, "--leader-network", "testnet", "--follower", copy.account, "--network", "testnet", "--since", since, "--db", "env",
      "--portfolio-url", `${API}/me/copy/live/portfolio`,
      ...(TERMS.sizingMode === "ratio" ? [] : ["--per-trade-usd", String(TERMS.perTradeUsd), "--max-per-trade-usd", String(TERMS.maxPerTradeUsd)]),
      "--max-leverage", String(TERMS.maxLeverage), ...allow.flatMap((a) => ["--allow-refusal", a]),
      // harness_timing's fallback when no coverage row is read: the testnet source's poll interval.
      "--source-poll-ms", String(Number(profileEnv(TERMS.profile).COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS) || 60_000)];
    let reconcile = null;
    const t0 = Date.now();
    for (let attempt = 1; ; attempt++) {
      const r = await node("reconcile.mjs", reconcileArgs, { quiet: true, env: { HARNESS_BEARER: await follower.token(), HARNESS_DATABASE_URL: env.DATABASE_URL } });
      try { reconcile = JSON.parse(r.out); } catch { reconcile = { failures: [{ check: "reconcile_crashed", detail: r.err.trim().split("\n").slice(-3).join(" ") }] }; }
      log("reconcile_attempt", { scenario: label, attempt, code: r.code, failures: reconcile.failures?.map((f) => f.check) });
      // Terminal refused legs cannot catch up. Preserve the failed reconcile
      // immediately and proceed to ordinary stop/return cleanup.
      const terminal = reconcile.failures?.some(f => ['refusal_not_allowed', 'signal_expired'].includes(f.check));
      // A leader order the source has not read yet (harness_timing) is waited for like a failure:
      // it only stands as harness_timing when the scenario ends (the deadline) or aborts (terminal).
      if ((r.code === 0 && !reconcile.harnessTiming?.length) || terminal || Date.now() - t0 > 240_000) break;
      await sleep(15_000);
    }
    writeFileSync(resolve(OUT, `${runId}-${label}-reconcile.json`), `${JSON.stringify(reconcile, null, 2)}\n`);
    const timing = reconcile.harnessTiming ?? [];
    const timingNote = timing.length ? `; harness_timing ${timing.length} (not failures: ${timing.map((h) => `${h.check} ${h.coin}${h.cause ? ` ${h.cause.rule}` : ""}`).join(", ")})` : "";
    check(`${label}_reconcile`, reconcile.failures?.length === 0, (reconcile.failures?.length ? reconcile.failures.map((f) => f.check).join(", ")
      : `${reconcile.leader?.orders} leader orders, ${reconcile.dispatches?.count} dispatches, ${reconcile.follower?.fills} follower fills`) + timingNote);
    lastReconcile = reconcile;
    return reconcile;
  }
  /** Stops the copy (unless `asked` already did), then: flat, the automatic return credited, shown stopped, never blocked. */
  async function stopCheck(label, copy, { request = true } = {}) {
    const beforeStop = await usdc(main);
    let blocked = null;
    try {
      const current = await copy.item();
      if (request) await follower.client.post(`/me/copy/live/mandates/${current.mandate.id}/stop`, { idempotencyKey: `harness-stop-${randomUUID()}`, expectedMandateRevision: current.mandate.revision });
      const stopped = await waitFor(copy.item, stopSettled, { timeoutMs: 600_000, intervalMs: 5000, onTick: (i) => {
        if (i?.stop?.state === "blocked") blocked = i.stop.issue;
        log("stop_stage", { scenario: label, stage: i?.stage, stop: i?.stop?.state, issue: i?.stop?.issue, sweep: i?.sweep });
      } });
      const copyAccount = await usdc(copy.account), afterStop = await usdc(main);
      check(`${label}_stop_never_blocked`, blocked === null, blocked ? `stop blocked: ${blocked}` : "");
      check(`${label}_stop_positions_closed`, copyAccount.positions.length === 0, copyAccount.positions.length ? JSON.stringify(copyAccount.positions) : "copy account flat");
      check(`${label}_stop_return_credited`, stopped.value?.sweep?.status === "credited" && afterStop.total > beforeStop.total,
        `sweep ${JSON.stringify(stopped.value?.sweep)}, main wallet ${beforeStop.total.toFixed(2)} → ${afterStop.total.toFixed(2)}, copy account left ${copyAccount.total.toFixed(2)}`);
      check(`${label}_stop_shown_stopped`, stopped.value?.stage === "stopped", `stage ${stopped.value?.stage}, stop ${stopped.value?.stop?.state}`);
    } catch (error) { check(`${label}_stop_shown_stopped`, false, error.message); }
  }
  const nowIso = () => new Date(Date.now() - 1000).toISOString();
  // stack.mjs's flags: the profile, and the roles (a restarted worker keeps its copy role when they are split).
  const profileArgs = [...(TERMS.profile !== "default" ? ["--profile", TERMS.profile] : []), ...(SPLIT ? ["--roles", "split"] : [])];
  const sizingArgs = ["--per-trade", String(TERMS.perTradeUsd), "--max-per-trade", String(TERMS.maxPerTradeUsd)];
  /** An admin client (kill switch): HARNESS_ADMIN_TOKEN, else the api's service token; never printed. */
  const adminToken = process.env.HARNESS_ADMIN_TOKEN || env.AUTH_SERVICE_TOKEN || null;
  const admin = adminToken ? apiClient(API, async () => adminToken) : null;

  /** The copy's legs by outcome, from the local database (psql, the stack's DATABASE_URL). */
  const legOutcomes = async (strategyId) => {
    const sql = `select state || ':' || coalesce(reason, '') as outcome, count(*) from copy_live_dispatches where mandate_id in (select id from copy_live_mandates where strategy_id = ${Number(strategyId)}) group by 1 order by 2 desc`;
    const out = await new Promise((resolveOut) => { const child = spawn("psql", [env.DATABASE_URL, "-At", "-F", "=", "-c", sql]); let text = ""; child.stdout.on("data", (d) => { text += d; }); child.on("close", () => resolveOut(text)); });
    return Object.fromEntries(out.trim().split("\n").filter(Boolean).map((line) => { const [k, v] = line.split("="); return [k, Number(v)]; }));
  };
  /** The manual stuck detector: setups, stops, funding and account-mode operations with an issue
   * whose retry is over 2 minutes past (lib.mjs stuckRowsSql), in the whole local database. */
  const stuckCheck = async () => {
    const result = await new Promise((resolveOut) => {
      const child = spawn("psql", [env.DATABASE_URL, "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", stuckRowsSql()]);
      let text = "", err = ""; child.stdout.on("data", (d) => { text += d; }); child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => resolveOut({ code: -1, text, err: e.message })); child.on("close", (code) => resolveOut({ code, text, err }));
    });
    if (result.code !== 0) return check("no_stuck_rows", false, `psql failed: ${result.err.trim().split("\n").at(-1)}`);
    const rows = parseStuckRows(result.text);
    return check("no_stuck_rows", rows.length === 0, rows.length ? rows.map((r) => `${r.table} ${r.id}: ${r.issue ?? `(no issue column) ${r.state}`}`).join("; ") : "none waiting over 2 min past its retry");
  };
  /** A refusal the copy may record for a real trader's leg; anything else is a defect. */
  const EXPECTED_REFUSALS = /^(refused:(merged_into_adjustment|below_min_notional|live_market_hip3_unsupported|no_follower_position|signal_expired|max_strategy_exposure|max_user_exposure|max_coin_exposure|available_collateral|max_order|copy_stopping|flip_close_not_settled|position_closed_by_owner))$/;
  /**
   * The orders the worker ran since `mark` (its live_execution_timing lines):
   * each one's evidence under EVIDENCE_MAX, and no attempt failed for its
   * evidence's age or generation proof. `required`: a scenario whose legs
   * must have produced orders (a gate scenario); otherwise none is a skip.
   * Returns the judged orders and the slice's failed attempts and refused legs
   * (the trip-wire's inputs, criteria.mjs tripWires).
   */
  async function evidenceCheck(label, mark, { required }) {
    if (mark.offset === null) { check(`${label}_evidence`, required ? false : null, `no worker log at ${WORKER_LOG} (--worker-log)`); return { orders: [], failures: [], refusals: [] }; }
    const scanned = scanWorkerLog(readLogFrom(mark.offset), { since: mark.at - 1000 }), failures = scanned.failures;
    // Testnet orders: judged without the dex fan-out (criteria.mjs); mainnet orders: raw.
    const venues = scanned.orders.some((o) => o.network === "testnet") ? await testnetVenues() : null;
    const dexes = { venues: venues?.venues ?? null, mainnetDexes: MAINNET_DEX_COUNT };
    const orders = judgeOrders(scanned.orders, dexes);
    const stats = judgedStats(orders, EVIDENCE_MAX);
    writeFileSync(resolve(OUT, `${runId}-${label}-evidence.json`), `${JSON.stringify({ maxMs: EVIDENCE_MAX, evidenceWindowMs: EVIDENCE_WINDOW, dexes: { ...dexes, read: venues }, stats, orders, failures }, null, 2)}\n`);
    const slowest = orders.reduce((a, b) => (!a || b.judgedMs > a.judgedMs ? b : a), null);
    check(`${label}_evidence_under_${EVIDENCE_MAX}ms`, orders.length ? stats.over === 0 : required ? false : null,
      orders.length ? `${evidenceDetail(orders, EVIDENCE_MAX, dexes, EVIDENCE_WINDOW)}; slowest phases ${JSON.stringify(slowest.phases)}`
        : `no live_execution_timing line in ${WORKER_LOG} since the scenario began`);
    const bad = failures.filter((f) => EVIDENCE_FAILURES.includes(f.reason));
    const count = (list) => JSON.stringify(Object.fromEntries([...new Set(list.map((f) => f.reason))].map((r) => [r, list.filter((f) => f.reason === r).length])));
    check(`${label}_no_evidence_failures`, bad.length === 0, bad.length ? `failed attempts: ${count(bad)}` : failures.length ? `other failed attempts: ${count(failures)}` : "no failed attempt");
    return { orders, failures, refusals: scanned.refusals };
  }
  /** Each scenario runs on `copy` (a running copy) and returns whether the copy still runs. */
  const scenarios = {
    // A real mainnet trader for WATCH_MIN minutes: what this stack does with its real fill rate and bursts.
    follow: async (copy) => {
      const mark = { offset: logSize(), at: Date.now() }, until = Date.now() + WATCH_MIN * 60_000;
      while (Date.now() < until) { log("follow_tick", { outcomes: await legOutcomes(copy.strategyId) }); await sleep(60_000); }
      const outcomes = await legOutcomes(copy.strategyId);
      const settled = outcomes["settled:"] ?? 0, unexpected = Object.entries(outcomes).filter(([k]) => k !== "settled:" && !k.startsWith("pending:") && !k.startsWith("submitted:") && !EXPECTED_REFUSALS.test(k));
      check("follow_legs_settled", settled > 0, `${settled} settled of ${Object.values(outcomes).reduce((a, b) => a + b, 0)}: ${JSON.stringify(outcomes)}`);
      check("follow_no_unexpected_refusal", unexpected.length === 0, unexpected.length ? JSON.stringify(Object.fromEntries(unexpected)) : "none");
      // 2026-10-12's codes: none at all, in any attempt, boundary failure or dispatch (a retry that later settled still counts).
      const scan = mark.offset === null ? null : scanWorkerLog(readLogFrom(mark.offset), { since: mark.at - 1000 });
      const zero = zeroCodeCounts({ failures: scan?.failures, boundary: scan?.boundary, outcomes });
      for (const [code, n] of Object.entries(zero))
        check(`follow_zero_${code}`, scan === null ? false : n.attempts + n.boundary + n.dispatches === 0,
          scan === null ? `no worker log at ${WORKER_LOG}` : `failed attempts ${n.attempts}, boundary failures ${n.boundary}, dispatches ${n.dispatches}`);
      await stopCheck("follow", copy);
      return false;
    },
    async base(copy) {
      const since = nowIso();
      await leaderRun("base", ["scenario", "base", "--gap", GAP]);
      await reconcileCheck("base", copy, since);
      // Withdraw 10 idle USDC.
      const beforeWithdraw = await usdc(main);
      try {
        const reserved = await follower.client.post(`/me/copy/live/execution-wallets/${copy.accountId}/returns`, { idempotencyKey: randomUUID(), amount: String(TERMS.withdrawUsd) });
        const op = reserved.operation ?? reserved;
        await follower.client.post(`/me/copy/live/returns/${op.id}/approve`);
        const done = await waitFor(async () => (await follower.client.get("/me/copy/funding")).operations.find((o) => o.id === op.id), (o) => ["credited", "rejected", "cancelled"].includes(o?.status), { timeoutMs: 180_000, intervalMs: 3000 });
        const after = await usdc(main);
        check("base_withdraw_10_credited", done.value?.status === "credited" && after.total >= beforeWithdraw.total + TERMS.withdrawUsd - 1.5,
          `return ${op.id} ${done.value?.status}, main wallet ${beforeWithdraw.total.toFixed(2)} → ${after.total.toFixed(2)}`);
      } catch (error) { check("base_withdraw_10_credited", false, error.message); }
      await stopCheck("base", copy);
      return false;
    },
    async "reduce-min"(copy) {
      const since = nowIso();
      await leaderRun("reduce_min", ["scenario", "reduce-min", "--gap", GAP]);
      await reconcileCheck("reduce_min", copy, since);
      return true;
    },
    async "stop-open"(copy) {
      const since = nowIso();
      await leaderRun("stop_open", ["open", "ETH", "20"]);
      const held = await followerHolds(copy, "ETH");
      check("stop_open_mirrored", held.ok, JSON.stringify(held.value.positions));
      await reconcileCheck("stop_open", copy, since);
      // Stop before the leader's close: the stop closes the open position.
      await stopCheck("stop_open", copy);
      await leaderRun("stop_open_cleanup", ["close", "ETH"]);
      return false;
    },
    async "close-then-stop"(copy) {
      const since = nowIso();
      await leaderRun("close_then_stop", ["open", "ETH", "20"]);
      const held = await followerHolds(copy, "ETH");
      check("close_then_stop_mirrored", held.ok, JSON.stringify(held.value.positions));
      await reconcileCheck("close_then_stop", copy, since);
      try {
        const close = await follower.client.post(`/me/copy/live/execution-wallets/${copy.accountId}/positions/close`, { idempotencyKey: randomUUID(), coin: "ETH" });
        check("close_then_stop_close_requested", close.state === "requested", `close ${close.id} ${close.state}`);
      } catch (error) { check("close_then_stop_close_requested", false, error.message); }
      await sleep(1500); // the stop within 2 s, while the close is in flight
      await stopCheck("close_then_stop", copy);
      await leaderRun("close_then_stop_cleanup", ["close", "ETH"]);
      return false;
    },
    async "worker-restart"(copy) {
      const since = nowIso();
      // Leave the leader's later half-reduction above the exchange minimum
      // after size rounding; the follower retains the original 12–15 USD cap.
      await leaderRun("worker_restart", ["open", "ETH", "40"]);
      // Right after the leader's trade, before the copy's fill.
      const restart = await node("stack.mjs", ["restart", "worker", ...profileArgs]);
      check("worker_restart_restarted", restart.code === 0, restart.lines.find((l) => l.event === "started") ? `worker pid ${restart.lines.find((l) => l.event === "started").pid}` : restart.err.trim().split("\n").at(-1));
      const held = await followerHolds(copy, "ETH");
      check("worker_restart_mirrored", held.ok, JSON.stringify(held.value.positions));
      await sleep(Number(GAP) * 1000);
      await leaderRun("worker_restart_reduce", ["reduce", "ETH", "0.5"]);
      await sleep(Number(GAP) * 1000);
      await leaderRun("worker_restart_close", ["close", "ETH"]);
      // No double send (an order outside the legs fails the reconcile), and the later legs traded.
      await reconcileCheck("worker_restart", copy, since);
      return true;
    },
    async "refused-open"(copy) {
      const since = nowIso();
      const r = await leaderRun("refused_open", ["scenario", "refused-open", "--gap", GAP, ...sizingArgs]);
      const odd = r.lines.find((l) => l.event === "start")?.refusable;
      if (!odd) { check("refused_open_coin", null, "no testnet perp makes the fixed amount fall under the minimum within the cap (skipped)"); return true; }
      await reconcileCheck("refused_open", copy, since, [`below_min_notional:${odd.coin}`]);
      const refused = (lastReconcile?.dispatches?.byStateReason ?? {})["refused/below_min_notional"] ?? 0;
      check("refused_open_was_refused", refused >= 1, `${refused} leg(s) refused below_min_notional on ${odd.coin}`);
      return true;
    },
    async burst(copy) {
      const since = nowIso();
      await leaderRun("burst", ["scenario", "burst", "--gap", GAP]);
      await reconcileCheck("burst", copy, since);
      const flat = await waitFor(() => usdc(copy.account), (b) => b.positions.length === 0, { timeoutMs: 120_000, intervalMs: 3000 });
      check("burst_follower_flat", flat.ok, JSON.stringify(flat.value.positions));
      return true;
    },
    async "kill-switch"(copy) {
      if (!admin) { check("kill_switch_admin", false, "no admin token (HARNESS_ADMIN_TOKEN or AUTH_SERVICE_TOKEN)"); return true; }
      const since = nowIso();
      const control = async (command, reason) => {
        const overview = await admin.get("/admin/copy/overview");
        return admin.post("/admin/copy/controls", { scope: "platform", command, reason, expectedRevision: overview.platform.revision });
      };
      let resumed = false;
      try {
        await leaderRun("kill_switch_open", ["open", "ETH", "20"]);
        const held = await followerHolds(copy, "ETH");
        check("kill_switch_mirrored", held.ok, JSON.stringify(held.value.positions));
        const before = held.value.positions.find((p) => p.coin === "ETH")?.szi ?? 0;
        await control("pause_new_risk", "copy harness kill switch drill");
        // An add is refused while paused…
        await leaderRun("kill_switch_add", ["open", "ETH", "20"]);
        await sleep(30_000);
        const afterAdd = (await usdc(copy.account)).positions.find((p) => p.coin === "ETH")?.szi ?? 0;
        check("kill_switch_open_refused", Math.abs(afterAdd) <= Math.abs(before) + 1e-9, `follower ETH ${before} → ${afterAdd}`);
        // …a reduction is still mirrored.
        await leaderRun("kill_switch_reduce", ["reduce", "ETH", "0.5"]);
        const reduced = await waitFor(() => usdc(copy.account), (b) => Math.abs(b.positions.find((p) => p.coin === "ETH")?.szi ?? 0) < Math.abs(afterAdd) - 1e-9, { timeoutMs: 120_000, intervalMs: 3000 });
        check("kill_switch_reduction_mirrored", reduced.ok, JSON.stringify(reduced.value.positions));
        await reconcileCheck("kill_switch", copy, since, ["platform_paused:ETH"]);
        // Admin close-all: the copy's stop closes and returns.
        try {
          const closed = await control("close_positions", "copy harness kill switch drill");
          check("kill_switch_close_all_complete", closed.event?.result?.complete === true && closed.event.result.liveStops >= 1, JSON.stringify(closed.event?.result));
        } catch (error) { check("kill_switch_close_all_complete", false, error.message); }
        await stopCheck("kill_switch", copy, { request: false });
        await control("resume", "copy harness kill switch drill over"); resumed = true;
      } finally {
        // Never leave the platform paused.
        if (!resumed) await control("resume", "copy harness kill switch drill over").catch((error) => check("kill_switch_resumed", false, error.message));
        await node("leader.mjs", ["flatten"], { quiet: true });
      }
      return false;
    },
    // --- the pre-mainnet gate's legs (lib.mjs GATE_SCENARIOS) ---
    // (21) Stage 2026-10-12: after the copy's first order every open of another coin was refused
    // live_generation_unproven. Each open waits for the follower's fill before the next coin's.
    async "new-coin"(copy) {
      const since = nowIso(), coins = ["BTC", "ETH", "SOL"];
      for (const coin of coins) {
        await leaderRun(`new_coin_open_${coin}`, ["open", coin, "20"]);
        const held = await followerHolds(copy, coin);
        if (!check(`new_coin_${coin}_mirrored`, held.ok, JSON.stringify(held.value.positions))) break;
      }
      for (const coin of [...coins].reverse()) {
        if ((await leaderState()).positions.some((p) => p.coin === coin && Number(p.szi) !== 0)) await leaderRun(`new_coin_close_${coin}`, ["close", coin]);
        await sleep(5000);
      }
      await reconcileCheck("new_coin", copy, since);
      return true;
    },
    // (22) open, a same-coin add, a partial reduce (half), a full close.
    async "add-reduce"(copy) {
      const since = nowIso();
      await leaderRun("add_reduce", ["scenario", "add-reduce", "--gap", GAP]);
      await reconcileCheck("add_reduce", copy, since);
      return true;
    },
    // (23) legs 3 s apart: one source read carries them, the copy merges them (ratio sizing).
    async merged(copy) {
      const since = nowIso();
      await leaderRun("merged", ["scenario", "merged", "--gap", GAP]);
      await reconcileCheck("merged", copy, since);
      const flat = await waitFor(() => usdc(copy.account), (b) => b.positions.length === 0, { timeoutMs: 120_000, intervalMs: 3000 });
      check("merged_follower_flat", flat.ok, JSON.stringify(flat.value.positions));
      const merged = (lastReconcile?.dispatches?.byStateReason ?? {})["refused/merged_into_adjustment"] ?? 0;
      // Informational: whether legs merge depends on the source read's timing (and on ratio sizing).
      check("merged_legs_merged", merged > 0 ? true : null, `${merged} leg(s) merged into another's order${TERMS.sizingMode === "ratio" ? "" : " (fixed sizing never merges)"}`);
      return true;
    },
    // (24) long → short in one leader fill: the copy's close leg, then its open leg.
    async flip(copy) {
      const since = nowIso();
      await leaderRun("flip", ["scenario", "flip", "--gap", GAP]);
      await reconcileCheck("flip", copy, since);
      return true;
    },
  };

  // --- 6. the scenarios ---------------------------------------------------------------------------------------
  log("scenarios", { list: SCENARIO_LIST, profile: TERMS.profile, terms: TERMS, evidenceWindowMs: EVIDENCE_WINDOW });
  if (DRY) {
    await startCopy("dry_run");
    // Each scenario's leader legs, planned from live markets (nothing signed).
    for (const name of SCENARIO_LIST) {
      const leaderScenario = ["base", "reduce-min", "burst", "refused-open", "new-coin", "add-reduce", "merged", "flip"].includes(name) ? name : null;
      if (!leaderScenario) { check(`dry_run_${name}_planned`, null, `${SCENARIOS[name].about} (orchestrated live; no leader plan)`); continue; }
      const r = await node("leader.mjs", ["scenario", leaderScenario, "--dry-run", ...sizingArgs], { quiet: true });
      const skipped = r.code === 0 && r.lines.some(l => l.event === "start" && l.skipped === true && l.reason === "no_refusable_market");
      check(`dry_run_${name}_planned`, skipped ? null : r.code === 0, skipped ? "no testnet perp fits scenario 8 within the cap" : r.code === 0 ? r.lines.filter((l) => l.event === "trade_planned").map((l) => l.label).join(" → ") : r.err.trim().split("\n").at(-1));
    }
    // The evidence check's input: the worker log's recent orders (none yet is a skip).
    const size = logSize();
    const recent = size === null ? null : scanWorkerLog(readLogFrom(Math.max(0, size - 4 * 2 ** 20)));
    const stats = recent && evidenceStats(recent.orders, EVIDENCE_MAX);
    check("dry_run_worker_log_timings", recent && recent.orders.length ? true : null, recent ? `${recent.orders.length} recent order(s) in ${WORKER_LOG}` +
      (stats.orders ? `: ${evidenceWindowLabel(EVIDENCE_WINDOW)}: evidence p50 ${stats.p50} / p95 ${stats.p95} / max ${stats.max} ms, ${stats.over} at or over ${EVIDENCE_MAX}` : "") : `no worker log at ${WORKER_LOG}`);
    await stuckCheck();
    await finish(checks.some((c) => c.ok === false) ? EXIT.failed : EXIT.green);
  }
  if (has("contention")) {
    // Stage's background lane, full, on the orders' egress key, with the profile's round trip.
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "contention.mjs")], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HARNESS_DATABASE_URL: env.DATABASE_URL, COPY_HARNESS_DB_RTT_MS: profileEnv(TERMS.profile).COPY_HARNESS_DB_RTT_MS ?? "0" } });
    contention = { child, counts: null, exited: false };
    const own = contention;
    child.stdout.on("data", (d) => { for (const line of String(d).split("\n")) { try { const j = JSON.parse(line); if (j.event === "contention") own.counts = j; } catch { /* partial line */ } } });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) => { own.exited = true; log("contention_exited", { code }); });
    await sleep(3000); // the lane fills before the first order
  }
  // Each scenario is judged on its own checks (criteria.mjs classifyScenario). A latency criterion miss
  // or a failed attempt whose retry settled is recorded as FAIL and the gate goes on: the copy continues
  // to the next scenario and to the final stop. A failure that makes continuing unsafe or meaningless
  // (a leader leg, a mirror, the reconcile, a stop, the follower not flat) aborts; the rest are SKIP.
  let copy = null;
  for (const [i, name] of SCENARIO_LIST.entries()) {
    copy ??= await startCopy(i === 0 ? "copy" : `copy_${i + 1}`);
    log("scenario_start", { scenario: name, about: SCENARIOS[name].about, strategyId: copy.strategyId, account: copy.account });
    const first = checks.length, mark = { offset: logSize(), at: Date.now() };
    lastReconcile = null;
    if (!(await scenarios[name](copy))) copy = null;
    const evidence = await evidenceCheck(name.replace(/-/g, "_"), mark, { required: GATE_SCENARIOS.includes(name) });
    const verdict = classifyScenario({ checks: checks.slice(first), ...evidence, maxMs: EVIDENCE_MAX });
    for (const key of ["failures", "refusals", "orders"]) gateRun[key].push(...evidence[key]);
    scenarioRows.push({ name, ok: verdict.ok, orders: evidence.orders, failed: verdict.failed, over: verdict.over, criterionMiss: verdict.criterionMiss, tripWire: verdict.tripWire,
      createdToSent: lastReconcile?.signalLatencySeconds?.createdToSent ?? null });
    log("scenario_end", { scenario: name, ok: verdict.ok, failed: verdict.failed, criterionMiss: verdict.criterionMiss, over: verdict.over,
      tripWireHits: verdict.tripWire.hits, lostLegs: verdict.tripWire.lostLegs, abort: verdict.abort });
    if (verdict.abort) {
      log("scenarios_stopped_after_failure", { scenario: name, checks: verdict.abortedBy });
      gateRun.abortedAfter = name; gateRun.abortedBy = verdict.abortedBy;
      for (const rest of SCENARIO_LIST.slice(i + 1)) scenarioRows.push({ name: rest, ok: null, orders: [] });
      break;
    }
    if (!verdict.ok) log("scenario_failed_gate_continues", { scenario: name, checks: verdict.failed });
  }
  // --- 7. a copy still running is stopped (its return credited), once no leg is in flight -------------------
  if (copy) { await waitInFlight("final"); await stopCheck("final", copy); }
  await stuckCheck();
  if (checks.some((c) => c.ok === false) && (await leaderState()).positions.length) await leaderRun("failure_cleanup", ["flatten"]);

  // Signal latency in two parts: leader fill → dispatch created (the source's poll, a harness fact on
  // testnet: measured only) and dispatch created → order sent (ours: the part any latency judgement uses).
  const split = lastReconcile?.signalLatencySeconds;
  const latency = lastReconcile?.latencySeconds ? { "signal received": lastReconcile.latencySeconds.received,
    ...(split ? { "fill → dispatch created (source poll)": split.leaderToCreated, "dispatch created → sent (ours)": split.createdToSent } : {}),
    "order sent": lastReconcile.latencySeconds.sent, "first follower fill": lastReconcile.latencySeconds.filled } : null;
  await finish(checks.some((c) => c.ok === false) ? EXIT.failed : EXIT.green, { latency, weightPerOrder: "n/a (the testnet bucket is not exposed by the worker)" });
} catch (error) {
  check("harness_error", false, `${error.name}: ${error.message}`);
  if (DRY && setupId) await follower?.client.post(`/me/copy/live/setups/${setupId}/cancel`).then((s) => log("dry_run_cancelled_after_error", { stage: s.stage }), () => {});
  await finish(EXIT.failed);
}
