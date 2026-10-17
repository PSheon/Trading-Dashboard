// The pre-mainnet gate's pure parts: the database round trip (db-rtt.mjs), the
// stage-like profile, the gate's scenarios and the worker-log evidence reader.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDbRtt, rttFromEnv } from "./db-rtt.mjs";
import { EVIDENCE_MAX_MS, FOLLOW_ZERO_CODES, evidenceWindowMs, GATE_SCENARIOS, SCENARIOS, evidenceStats, lastStartRtt, orderEvidence, parseScenarios, parseStuckRows, profileEnv, renderGateSummary, renderSpans,
  scanWorkerLog, spanStats, spansByRole, stuckRowsSql, termsFor, zeroCodeCounts } from "./lib.mjs";

/** A stand-in for pg's Client: records when each statement reached it. */
function fakeClient() {
  return class Fake {
    sent = [];
    query(...args) {
      this.sent.push({ at: performance.now(), text: typeof args[0] === "string" ? args[0] : args[0]?.text ?? "submittable" });
      const callback = args.find((a) => typeof a === "function");
      if (callback) { callback(null, { rows: [args[0]] }); return undefined; }
      if (args[0] && typeof args[0].submit === "function") return args[0];
      return Promise.resolve({ rows: [args[0]] });
    }
  };
}

test("rttFromEnv: off unless set; an integer 0–1000 ms; never with NODE_ENV=production", () => {
  assert.equal(rttFromEnv({}), 0);
  assert.equal(rttFromEnv({ COPY_HARNESS_DB_RTT_MS: "" }), 0);
  assert.equal(rttFromEnv({ COPY_HARNESS_DB_RTT_MS: "8" }), 8);
  for (const bad of ["x", "-1", "1.5", "1001"]) assert.throws(() => rttFromEnv({ COPY_HARNESS_DB_RTT_MS: bad }), /integer 0–1000/);
  assert.throws(() => rttFromEnv({ COPY_HARNESS_DB_RTT_MS: "8", NODE_ENV: "production" }), /refused with NODE_ENV=production/);
  assert.equal(rttFromEnv({ COPY_HARNESS_DB_RTT_MS: "0", NODE_ENV: "production" }), 0);
});

test("installDbRtt: 0 ms leaves the client untouched", () => {
  const Fake = fakeClient(), original = Fake.prototype.query;
  installDbRtt(Fake, 0)();
  assert.equal(Fake.prototype.query, original);
});

test("installDbRtt: promise and callback statements wait the round trip, in the order they were issued", async () => {
  const Fake = fakeClient(), original = Fake.prototype.query;
  let counted = 0;
  const restore = installDbRtt(Fake, 40, { onQuery: () => { counted++; } });
  try {
    const client = new Fake(), started = performance.now();
    const answers = await Promise.all([
      client.query("BEGIN"),
      new Promise((resolve) => { assert.equal(client.query({ text: "SELECT 1" }, undefined, (_e, r) => resolve(r)), undefined); }),
      client.query("SELECT 2", []),
      client.query("COMMIT"),
    ]);
    assert.deepEqual(answers.map((a) => a.rows[0]?.text ?? a.rows[0]), ["BEGIN", "SELECT 1", "SELECT 2", "COMMIT"]);
    assert.deepEqual(client.sent.map((s) => s.text), ["BEGIN", "SELECT 1", "SELECT 2", "COMMIT"]);
    for (const s of client.sent) assert.ok(s.at - started >= 35, `sent after ${s.at - started} ms`);
    assert.equal(counted, 4);
    assert.throws(() => installDbRtt(Fake, 8), /already installed \(40 ms\)/);
  } finally { restore(); }
  assert.equal(Fake.prototype.query, original);
});

test("installDbRtt: a submittable (cursor, stream) goes through at once", () => {
  const Fake = fakeClient(), restore = installDbRtt(Fake, 1000);
  try {
    const client = new Fake(), cursor = { submit() {} };
    assert.equal(client.query(cursor), cursor);
    assert.equal(client.sent.length, 1);
  } finally { restore(); }
});

test("stage-like: ratio-floor's terms and files, then Stage's 8 ms round trip", () => {
  assert.deepEqual(termsFor("stage-like"), { ...termsFor("ratio-floor"), profile: "stage-like" });
  const env = profileEnv("stage-like"), ratio = profileEnv("ratio-floor");
  assert.equal(env.COPY_HARNESS_DB_RTT_MS, "8");
  assert.equal(env.COPY_LIVE_FAST_SOURCE, "all");
  // The testnet evidence window (gate 11, 2026-10-16): stage-like only; the other profiles run mainnet's 5000.
  assert.equal(env.COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS, "7000");
  assert.equal(evidenceWindowMs(env), 7000);
  for (const other of ["default", "ratio-floor", "stage-caps"]) assert.equal(evidenceWindowMs(profileEnv(other)), 5000, other);
  assert.equal(EVIDENCE_MAX_MS, 3500);
  // The 7000 stays local: the api image (Railway: apps/api/Dockerfile) carries apps/api and packages/shared, never scripts/.
  const dockerfile = readFileSync(resolve(import.meta.dirname, "../../apps/api/Dockerfile"), "utf8");
  assert.deepEqual(dockerfile.split("\n").filter((l) => /^COPY (?!--from)/.test(l)).map((l) => l.split(/\s+/)[1]).filter((src) => !["pnpm-workspace.yaml", "patches", "apps/api/package.json", "packages/shared/package.json", "tsconfig.json", "apps/api", "packages/shared"].includes(src)), []);
  for (const [key, value] of Object.entries(ratio)) assert.equal(env[key], value, key);
  assert.equal(ratio.COPY_HARNESS_DB_RTT_MS, undefined);
  assert.equal(profileEnv().COPY_HARNESS_DB_RTT_MS, undefined);
  assert.throws(() => profileEnv("mainnet"), /unknown profile/);
});

test("gate: every leg type in order on a fresh copy, new-coin first, ending with a stop and its return", () => {
  assert.deepEqual(parseScenarios("gate"), GATE_SCENARIOS);
  assert.equal(GATE_SCENARIOS[0], "new-coin");
  assert.equal(SCENARIOS[GATE_SCENARIOS.at(-1)].endsCopy, true);
  assert.ok(GATE_SCENARIOS.slice(0, -1).every((name) => SCENARIOS[name] && !SCENARIOS[name].endsCopy));
  assert.deepEqual(parseScenarios("21,22,23,24"), ["new-coin", "add-reduce", "merged", "flip"]);
  assert.deepEqual(parseScenarios("gate,stop-open,follow"), [...GATE_SCENARIOS, "follow"]);
});

// A real order's timings (worker log, 2026-10-12), trimmed to the execute marks and one of each phase.
const ORDER = [
  { phase: "prepare", stage: "preparation_local_authority", elapsedMs: 16, totalMs: 16 },
  { phase: "collect", stage: "epoch_final_authority", elapsedMs: 21, totalMs: 2317 },
  { phase: "prepare", stage: "preparation_journal_transaction", elapsedMs: 156, totalMs: 2631 },
  { phase: "execute", stage: "runtime_prepare", elapsedMs: 2631, totalMs: 2631 },
  { phase: "hold", stage: "risk_proof_build", elapsedMs: 2, totalMs: 172 },
  { phase: "execute", stage: "runtime_hold", elapsedMs: 211, totalMs: 2842 },
  { phase: "execute", stage: "executor_prepare", elapsedMs: 11, totalMs: 11 },
  { phase: "execute", stage: "executor_sign_gate", elapsedMs: 178, totalMs: 189 },
  { phase: "sign", stage: "signer_signature_verify", elapsedMs: 6, totalMs: 584 },
  { phase: "execute", stage: "executor_sign", elapsedMs: 585, totalMs: 774 },
  { phase: "execute", stage: "executor_persist_submitting", elapsedMs: 35, totalMs: 809 },
  { phase: "submit", stage: "risk_proof_build", elapsedMs: 1, totalMs: 226 },
  { phase: "execute", stage: "executor_submit_gate", elapsedMs: 242, totalMs: 1051 },
  { phase: "execute", stage: "executor_submit", elapsedMs: 991, totalMs: 2042 },
].map((t) => ({ network: "testnet", clockValid: true, ...t }));

test("orderEvidence: from the preparation's start to the last evidence check before the exchange", () => {
  assert.deepEqual(orderEvidence(ORDER), { network: "testnet", evidenceMs: 2842 + 1051, orderMs: 2842 + 2042, submitted: true,
    phases: { prepare: 2631, collect: 2317, execute: 2842, hold: 172, sign: 584, submit: 226 } });
  // An order refused before the exchange: its evidence up to the last executor stage it reached.
  const refused = ORDER.filter((t) => !["executor_persist_submitting", "executor_submit_gate", "executor_submit"].includes(t.stage) && t.phase !== "submit");
  assert.equal(orderEvidence(refused).evidenceMs, 2842 + 774);
  assert.equal(orderEvidence(refused).submitted, false);
  // Refused at the hold: the runtime's own mark only.
  assert.equal(orderEvidence(ORDER.slice(0, 4)).evidenceMs, 2631);
  // A recovery's reconcile (no preparation) is not an order.
  assert.equal(orderEvidence(ORDER.slice(6)), null);
  assert.equal(orderEvidence(undefined), null);
});

const line = (timestamp, message, context = "LiveExecutionRuntime") => JSON.stringify({ timestamp, level: "info", context, message });
const LOG = [
  line("2026-10-12T04:00:00.000Z", { event: "live_execution_timing", timings: ORDER, spans: [{ span: "quota_rest_tx:follower", count: 3, totalMs: 90, maxMs: 40, firstAtMs: 0, lastEndMs: 200 }] }),
  line("2026-10-12T04:00:01.000Z", "leg m|f|open attempt 2 failed: live_risk_stale; elapsed 7744 ms, source age 9948 ms, exchange started false", "CopyLiveEngine"),
  "not json",
  line("2026-10-12T04:00:02.000Z", "leg m|g|close attempt 1 failed: live_budget_wait; elapsed 12 ms, source age 900 ms, exchange started false", "CopyLiveEngine"),
  line("2026-10-12T04:00:03.000Z", { event: "live_execution_timing", timings: ORDER.slice(0, 4), spans: [] }),
  line("2026-10-12T04:00:04.000Z", { event: "live_execution_timing", timings: ORDER.slice(6), spans: [] }),
  line("2026-10-12T04:00:05.000Z", "Copy order x: received +10, first attempt +20, sent +900 ms after the leader", "CopyLiveEngine"),
  line("2026-10-12T04:00:06.000Z", { event: "live_execution_boundary_failure", network: "testnet", stage: "transport_shared_quota", elapsedMs: 3, errorCode: "hyperliquid_busy", budgetReason: "shared_capacity" }),
  line("2026-10-12T04:00:07.000Z", "leg m|f|open refused: signal_expired (source age 120172 ms, 2 attempt(s), last live_risk_stale)", "CopyLiveEngine"),
  line("2026-10-12T04:00:08.000Z", "leg m|h|open kept for the next pass: live_account_observation_unavailable", "CopyLiveEngine"),
].join("\n");

test("scanWorkerLog: the orders, failed attempts and refused legs in a window of the worker's log", () => {
  const all = scanWorkerLog(LOG);
  assert.deepEqual(all.orders.map((o) => [o.at, o.evidenceMs, o.submitted]), [["2026-10-12T04:00:00.000Z", 3893, true], ["2026-10-12T04:00:03.000Z", 2631, false]]);
  assert.equal(all.orders[0].spans[0].span, "quota_rest_tx:follower");
  assert.deepEqual(all.failures.map((f) => [f.leg, f.attempt, f.reason, f.elapsedMs, f.sourceAgeMs]), [["m|f|open", 2, "live_risk_stale", 7744, 9948], ["m|g|close", 1, "live_budget_wait", 12, 900]]);
  // The engine's `leg … refused: …` line: the leg given up on, its attempts and the last attempt's code (a leg kept for another pass is not one).
  assert.deepEqual(all.refusals, [{ at: "2026-10-12T04:00:07.000Z", leg: "m|f|open", reason: "signal_expired", sourceAgeMs: 120172, attempts: 2, last: "live_risk_stale" }]);
  const later = scanWorkerLog(LOG, { since: Date.parse("2026-10-12T04:00:01.500Z") });
  assert.equal(later.orders.length, 1);
  assert.deepEqual(later.failures.map((f) => f.reason), ["live_budget_wait"]);
  assert.deepEqual(all.boundary, [{ at: "2026-10-12T04:00:06.000Z", stage: "transport_shared_quota", errorCode: "hyperliquid_busy", budgetReason: "shared_capacity" }]);
  assert.deepEqual(scanWorkerLog(LOG, { until: Date.parse("2026-10-12T03:59:59Z") }), { orders: [], failures: [], boundary: [], refusals: [] });
});

test("evidenceStats and the gate's table: p50/p95/max per scenario and over all", () => {
  const orders = [1000, 2000, 3000, 3600].map((evidenceMs) => ({ evidenceMs }));
  assert.deepEqual(evidenceStats(orders), { orders: 4, p50: 2000, p95: 3600, max: 3600, over: 1 });
  assert.deepEqual(evidenceStats([], 3500), { orders: 0, p50: null, p95: null, max: null, over: 0 });
  assert.equal(evidenceStats([{ evidenceMs: EVIDENCE_MAX_MS }]).over, 1);
  const table = renderGateSummary([{ name: "new-coin", ok: true, orders: orders.slice(0, 2) }, { name: "flip", ok: false, orders: orders.slice(2) }, { name: "stop-open", ok: null, orders: [] }]);
  const rows = table.split("\n");
  assert.match(rows[0], /each order's judged evidence < 3500 ms; evidence window 5000 ms \(mainnet's\)$/);
  assert.match(rows[1], /window   miss  trip   sent  \(/);
  // Without a judged number (no fan-out computed) the raw one is judged; no projection. Then the window in force, the
  // two classes (none given: 0) and the dispatch created → sent latency (none given: —).
  assert.match(rows[3], /^new-coin\s+PASS\s+2\s+1000\s+2000\s+2000\s+2000\s+—\s+5000\s+0\s+0\s+—$/);
  assert.match(rows[4], /^flip\s+FAIL\s+2\s+3000\s+3600\s+3600\s+3600\s+—\s+5000\s+0\s+0\s+—$/);
  assert.match(rows[5], /^stop-open\s+SKIP\s+0\s+—\s+—\s+—\s+—\s+—\s+5000\s+—\s+—\s+—$/);
  assert.match(rows[6], /^all\s+FAIL\s+4\s+2000\s+3600\s+3600\s+3600\s+—\s+5000\s+0\s+0\s+—$/);
  // A 7000 run says so on the title and on every row: never read as mainnet-equivalent.
  const wide = renderGateSummary([{ name: "new-coin", ok: true, orders: orders.slice(0, 2) }], 3500, 7000).split("\n");
  assert.match(wide[0], /judged evidence < 3500 ms; evidence window 7000 ms \(TESTNET allowance, not mainnet-equivalent; mainnet stays 5000\)$/);
  assert.match(wide[3], /^new-coin\s+PASS\s+2\s+1000\s+2000\s+2000\s+2000\s+—\s+7000\s+0\s+0\s+—$/);
  assert.throws(() => evidenceWindowMs({ COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS: "4000" }), /not a window/);
});

test("the gate's table carries each scenario's class (criterion miss, trip-wire hits) and its dispatch created → sent latency; `all` sums them", () => {
  const orders = (...xs) => xs.map((evidenceMs) => ({ evidenceMs }));
  const trip = (hits, lost = []) => ({ lostLegs: lost, expiredAttempts: 0, attempts: 1, expiredShare: 0, shareTripped: false, hits });
  const rows = renderGateSummary([
    { name: "new-coin", ok: true, orders: orders(3107), criterionMiss: false, tripWire: trip(0), createdToSent: { n: 1, p50: 8.37, p95: 8.37, max: 8.37 } },
    // Gate 12's merged: one order over the limit, every leg settled: a miss, and the gate went on to flip.
    { name: "merged", ok: false, orders: orders(3591, 2900), criterionMiss: true, tripWire: trip(0), createdToSent: { n: 2, p50: 7.1, p95: 9.2, max: 9.2 } },
    { name: "flip", ok: false, orders: orders(3000), criterionMiss: false, tripWire: trip(2, [{ leg: "x" }]), createdToSent: null },
    { name: "stop-open", ok: null, orders: [] },
  ], 3500, 7000).split("\n");
  assert.match(rows[3], /^new-coin\s+PASS\s+1\s+3107\s+3107\s+3107\s+3107\s+—\s+7000\s+0\s+0\s+8\.37$/);
  assert.match(rows[4], /^merged\s+FAIL\s+2\s+2900\s+3591\s+3591\s+3591\s+—\s+7000\s+1\s+0\s+7\.10$/);
  assert.match(rows[5], /^flip\s+FAIL\s+1\s+3000\s+3000\s+3000\s+3000\s+—\s+7000\s+0\s+2\s+—$/);
  assert.match(rows[6], /^stop-open\s+SKIP\s+0\s+—\s+—\s+—\s+—\s+—\s+7000\s+—\s+—\s+—$/);
  // all: scenarios with a miss, hits summed, the scenarios' largest max (s).
  assert.match(rows[7], /^all\s+FAIL\s+4\s+3000\s+3591\s+3591\s+3591\s+—\s+7000\s+1\s+2\s+9\.20$/);
});

test("lastStartRtt: the round trip of the worker's latest start", () => {
  const preload = (ms) => JSON.stringify({ at: "t", event: "copy_harness_db_rtt", ms });
  const start = line("2026-10-12T04:00:00.000Z", "Starting Nest application...", "NestFactory");
  assert.equal(lastStartRtt("nothing here"), null);
  assert.equal(lastStartRtt([preload(8), start].join("\n")), 8);
  assert.equal(lastStartRtt([preload(8), start, "x", start].join("\n")), 0);
  assert.equal(lastStartRtt([start, preload(8), start, LOG].join("\n")), 8);
});

test("spans: per role for each order, and p50/p95/max of each span over the orders", () => {
  const a = { at: "a", evidenceMs: 3000, spans: [{ span: "quota_rest_tx:follower", totalMs: 90 }, { span: "quota_rest_tx:leader", totalMs: 40 }, { span: "local_budget", totalMs: 5 }, { span: "ws_open:follower", totalMs: 10 }] };
  const b = { at: "b", evidenceMs: 2000, spans: [{ span: "quota_rest_tx:follower", totalMs: 300 }, { span: "rest_wave_http:target", totalMs: 120 }] };
  assert.deepEqual(spansByRole(a), { follower: 100, leader: 40, none: 5 });
  assert.deepEqual(spansByRole({}), {});
  assert.deepEqual(spanStats([a, b])[0], { span: "quota_rest_tx:follower", orders: 2, p50: 90, p95: 300, max: 300 });
  assert.equal(spanStats([a, b]).length, 5);
  const text = renderSpans([{ name: "flip", orders: [a, b] }]);
  assert.match(text, /flip\s+a\s+evidence  3000  follower 100, leader 40, target 0, other_account 0, none 5/);
  assert.match(text, /quota_rest_tx:follower\s+2\s+90\s+300\s+300/);
});

test("zeroCodeCounts: each of 2026-10-12's codes in attempts, boundary failures and dispatches", () => {
  const { failures, boundary } = scanWorkerLog(LOG);
  const counts = zeroCodeCounts({ failures, boundary, outcomes: { "settled:": 4, "refused:live_risk_stale": 2, "refused:live_generation_unproven": 1, "pending:": 1 } });
  assert.deepEqual(Object.keys(counts), FOLLOW_ZERO_CODES);
  assert.deepEqual(counts.live_risk_stale, { attempts: 1, boundary: 0, dispatches: 2 });
  assert.deepEqual(counts.hyperliquid_busy, { attempts: 0, boundary: 1, dispatches: 0 });
  assert.deepEqual(counts.live_generation_unproven, { attempts: 0, boundary: 0, dispatches: 1 });
  assert.deepEqual(zeroCodeCounts({}).live_risk_stale, { attempts: 0, boundary: 0, dispatches: 0 });
});

test("stuckRowsSql: rows with an issue over 2 min past their retry, in non-final states, per table", () => {
  const sql = stuckRowsSql();
  assert.match(sql, /from copy_live_setups where issue is not null and stage not in \('running', 'cancelled', 'failed', 'expired'\) and next_attempt_at < now\(\) - interval '120 seconds'/);
  assert.match(sql, /from copy_live_stop_operations where issue is not null and state <> 'stopped' and updated_at < now\(\) - interval '120 seconds'/);
  assert.match(sql, /from copy_funding_operations where status not in \('credited', 'rejected', 'cancelled'\) and updated_at </);
  assert.match(sql, /from copy_account_mode_operations where issue is not null and target_state not in \('supported', 'unsupported'\)/);
  // An unattempted operation left behind by a setup that ended is not stuck (gate 13: f0dbea7b under a cancelled setup).
  assert.match(sql, /and not \(attempted_at is null and exists \(select 1 from copy_live_setups s where s.id = copy_account_mode_operations.live_setup_id and s.stage in \('cancelled', 'failed', 'expired'\)\)\)/);
  assert.equal(sql.split(" union all ").length, 4);
  assert.match(stuckRowsSql({ userId: 7, since: "2026-10-12T04:00:00Z" }), /and user_id = 7 and created_at >= '2026-10-12T04:00:00.000Z'/);
  assert.throws(() => stuckRowsSql({ userId: "1; drop table x" }), /userId/);
  assert.throws(() => stuckRowsSql({ since: "'; drop" }), /since/);
  assert.deepEqual(parseStuckRows("copy_live_setups|s1|live_setup_funding_wait|funding_submitted|2026-10-12 04:00:00\ncopy_funding_operations|f1||claimed|2026-10-12 04:00:00\n"), [
    { table: "copy_live_setups", id: "s1", issue: "live_setup_funding_wait", state: "funding_submitted", since: "2026-10-12 04:00:00" },
    { table: "copy_funding_operations", id: "f1", issue: null, state: "claimed", since: "2026-10-12 04:00:00" }]);
});

// --- legs in flight (gate 13: the flip's reconcile window closed on a pending attempt) -----------------------
import { DEFAULT_SIGNAL_AGE_LIMIT_MS, IN_FLIGHT_WAIT_MARGIN_MS, IN_FLIGHT_WAIT_MAX_MS, inFlightDispatches, inFlightSql, inFlightWaitMs, waitForInFlight } from "./lib.mjs";

test("inFlightWaitMs: the signal-age limit plus the margin, 150 s at most; the policy's default without a limit", () => {
  assert.equal(DEFAULT_SIGNAL_AGE_LIMIT_MS, 120_000);
  assert.equal(inFlightWaitMs(60_000), 60_000 + IN_FLIGHT_WAIT_MARGIN_MS);
  assert.equal(inFlightWaitMs(120_000), IN_FLIGHT_WAIT_MAX_MS);
  assert.equal(inFlightWaitMs(600_000), IN_FLIGHT_WAIT_MAX_MS);
  assert.equal(inFlightWaitMs(), inFlightWaitMs(DEFAULT_SIGNAL_AGE_LIMIT_MS));
  assert.equal(inFlightWaitMs(NaN), inFlightWaitMs(DEFAULT_SIGNAL_AGE_LIMIT_MS));
});

test("inFlightSql: the copies' non-terminal legs with their attempt fields, nothing else", () => {
  const sql = inFlightSql([7, 9]);
  assert.match(sql, /from copy_live_dispatches where strategy_id in \(7,9\) and state in \('pending', 'submitted'\)/);
  for (const col of ["state", "reason", "attempts", 'first_attempt_at as "firstAttemptAt"']) assert.ok(sql.includes(col), col);
  assert.doesNotMatch(sql, /address|signature|record|key/);
  assert.throws(() => inFlightSql([]), /strategyIds/);
  assert.throws(() => inFlightSql(["1; drop"]), /strategyIds/);
});

test("inFlightDispatches: a running attempt, a retry due or a submitted order is in flight; a fresh pending leg or a terminal one is not", () => {
  const rows = [
    // Gate 13's flip open: pending, its first attempt running (dispatch state pending, first_attempt_at set).
    { id: "running", leg: "open", coin: "ETH", state: "pending", reason: null, attempts: 0, firstAttemptAt: "2026-10-17T05:00:00.000Z" },
    { id: "retry", leg: "open", coin: "ETH", state: "pending", reason: "unsent_retry", attempts: 1, firstAttemptAt: "2026-10-17T05:00:00.000Z" },
    { id: "failed-once", leg: "close", coin: "ETH", state: "pending", reason: null, attempts: 1, firstAttemptAt: null },
    { id: "sent", leg: "close", coin: "ETH", state: "submitted", reason: null, attempts: 1, firstAttemptAt: "2026-10-17T05:00:01.000Z" },
    { id: "fresh", leg: "open", coin: "SOL", state: "pending", reason: null, attempts: 0, firstAttemptAt: null },
    { id: "done", leg: "open", coin: "BTC", state: "settled", reason: null, attempts: 1, firstAttemptAt: "2026-10-17T04:00:00.000Z" },
    { id: "refused", leg: "open", coin: "BTC", state: "refused", reason: "signal_expired", attempts: 3, firstAttemptAt: "2026-10-17T04:00:00.000Z" },
  ];
  assert.deepEqual(inFlightDispatches(rows).map((d) => d.id), ["running", "retry", "failed-once", "sent"]);
  assert.deepEqual(inFlightDispatches(rows)[0], { id: "running", leg: "open", coin: "ETH", state: "pending", reason: null, attempts: 0, firstAttemptAt: "2026-10-17T05:00:00.000Z" });
  assert.deepEqual(inFlightDispatches([]), []);
});

test("waitForInFlight: a pending leg with a running attempt delays the judging until it settles; nothing in flight → no wait at all", async () => {
  let clock = 1_000_000;
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); clock += ms; };
  const now = () => clock;
  const running = { id: "d1", leg: "open", coin: "ETH", state: "pending", reason: null, attempts: 0, firstAttemptAt: "2026-10-17T05:00:00.000Z" };
  // In flight on the first two reads, settled on the third.
  const reads = [[running], [{ ...running, state: "submitted", attempts: 1 }], [{ ...running, state: "settled", attempts: 1 }]];
  let i = 0;
  const waited = await waitForInFlight(async () => reads[Math.min(i++, reads.length - 1)], { waitMs: 150_000, intervalMs: 3000, now, sleep });
  assert.deepEqual(waited.dispatches.map((d) => d.id), ["d1"]);
  assert.deepEqual(waited.left, []);
  assert.equal(waited.polls, 3);
  assert.deepEqual(slept, [3000, 3000]);
  assert.equal(waited.waitedMs, 6000);
  assert.equal(waited.timedOut, false);
  // Nothing in flight: one read, no sleep, waitedMs 0 (the wait is never extended).
  slept.length = 0;
  const none = await waitForInFlight(async () => [{ ...running, state: "settled" }, { ...running, id: "d2", firstAttemptAt: null }], { waitMs: 150_000, now, sleep });
  assert.deepEqual(none, { dispatches: [], left: [], waitedMs: 0, polls: 1, timedOut: false });
  assert.deepEqual(slept, []);
  // Still in flight at the deadline: gives up at waitMs, the last sleep clipped to it.
  slept.length = 0;
  const stuck = await waitForInFlight(async () => [running], { waitMs: 7000, intervalMs: 3000, now, sleep });
  assert.equal(stuck.timedOut, true);
  assert.deepEqual(stuck.left.map((d) => d.id), ["d1"]);
  assert.deepEqual(slept, [3000, 3000, 1000]);
  assert.equal(stuck.waitedMs, 7000);
});

test("run.mjs waits for in-flight legs before a scenario's reconcile and before the final stop, and restarts the worker with the roles it runs", () => {
  const source = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const reconcile = source.slice(source.indexOf("async function reconcileCheck("), source.indexOf("async function stopCheck("));
  assert.match(reconcile, /^\s*await waitInFlight\(label\);/m, "the reconcile window opens only once no leg is in flight");
  assert.ok(source.indexOf("await waitInFlight(label)") < source.indexOf('await node("reconcile.mjs"'), "the wait precedes the first reconcile attempt");
  assert.match(source.slice(source.indexOf("// --- 7.")), /if \(copy\) \{ await waitInFlight\("final"\); await stopCheck\("final", copy\); \}/, "the final stop waits too");
  const wait = source.slice(source.indexOf("async function waitInFlight("), source.indexOf("async function reconcileCheck("));
  assert.match(wait, /waitForInFlight\(inFlightRows, \{ waitMs, intervalMs: 3000 \}\)/);
  assert.match(wait, /log\("scenario_wait_in_flight", \{ scenario: label, dispatches: [\s\S]*waitedMs: waited\.waitedMs/);
  assert.match(wait, /inFlightWaitMs\(limit\.ms\)/, "bounded by the signal-age limit plus the margin");
  assert.match(source, /admin\.get\("\/admin\/copy\/risk"\)\)\.limits\?\.maxSignalAgeSeconds/, "the limit is read from the api's risk policy when an admin token is given");
  // --roles split: the stack check wants both roles, the worker-restart scenario keeps the copy role, the read worker is measured.
  assert.match(source, /const SPLIT = ROLES === "split";/);
  assert.match(source, /check\("stack_worker_roles", copyRole === "copy" && readRole === "read"/);
  assert.match(source, /\.\.\.\(SPLIT \? \["--roles", "split"\] : \[\]\)\]/, "stack.mjs restart worker gets --roles split");
  assert.match(source, /\.\.\.\(SPLIT \? \[WORKER_READ\] : \[\]\)/, "the read worker's heartbeat is measured");
  assert.match(source, /m\.roles = workerRolesLabel\(measureRun\.heartbeats \?\? \[\], \{ copy: WORKER, read: SPLIT \? WORKER_READ : null \}\)/);
});
