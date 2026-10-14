// The pre-mainnet gate's pure parts: the database round trip (db-rtt.mjs), the
// stage-like profile, the gate's scenarios and the worker-log evidence reader.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installDbRtt, rttFromEnv } from "./db-rtt.mjs";
import { EVIDENCE_MAX_MS, FOLLOW_ZERO_CODES, GATE_SCENARIOS, SCENARIOS, evidenceStats, lastStartRtt, orderEvidence, parseScenarios, parseStuckRows, profileEnv, renderGateSummary, renderSpans,
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
].join("\n");

test("scanWorkerLog: the orders and failed attempts in a window of the worker's log", () => {
  const all = scanWorkerLog(LOG);
  assert.deepEqual(all.orders.map((o) => [o.at, o.evidenceMs, o.submitted]), [["2026-10-12T04:00:00.000Z", 3893, true], ["2026-10-12T04:00:03.000Z", 2631, false]]);
  assert.equal(all.orders[0].spans[0].span, "quota_rest_tx:follower");
  assert.deepEqual(all.failures.map((f) => [f.leg, f.attempt, f.reason, f.elapsedMs, f.sourceAgeMs]), [["m|f|open", 2, "live_risk_stale", 7744, 9948], ["m|g|close", 1, "live_budget_wait", 12, 900]]);
  const later = scanWorkerLog(LOG, { since: Date.parse("2026-10-12T04:00:01.500Z") });
  assert.equal(later.orders.length, 1);
  assert.deepEqual(later.failures.map((f) => f.reason), ["live_budget_wait"]);
  assert.deepEqual(all.boundary, [{ at: "2026-10-12T04:00:06.000Z", stage: "transport_shared_quota", errorCode: "hyperliquid_busy", budgetReason: "shared_capacity" }]);
  assert.deepEqual(scanWorkerLog(LOG, { until: Date.parse("2026-10-12T03:59:59Z") }), { orders: [], failures: [], boundary: [] });
});

test("evidenceStats and the gate's table: p50/p95/max per scenario and over all", () => {
  const orders = [1000, 2000, 3000, 3600].map((evidenceMs) => ({ evidenceMs }));
  assert.deepEqual(evidenceStats(orders), { orders: 4, p50: 2000, p95: 3600, max: 3600, over: 1 });
  assert.deepEqual(evidenceStats([], 3500), { orders: 0, p50: null, p95: null, max: null, over: 0 });
  assert.equal(evidenceStats([{ evidenceMs: EVIDENCE_MAX_MS }]).over, 1);
  const table = renderGateSummary([{ name: "new-coin", ok: true, orders: orders.slice(0, 2) }, { name: "flip", ok: false, orders: orders.slice(2) }, { name: "stop-open", ok: null, orders: [] }]);
  const rows = table.split("\n");
  assert.match(rows[0], /each order's judged evidence < 3500 ms/);
  // Without a judged number (no fan-out computed) the raw one is judged; no projection.
  assert.match(rows[2], /^new-coin\s+PASS\s+2\s+1000\s+2000\s+2000\s+2000\s+—$/);
  assert.match(rows[3], /^flip\s+FAIL\s+2\s+3000\s+3600\s+3600\s+3600\s+—$/);
  assert.match(rows[4], /^stop-open\s+SKIP\s+0\s+—\s+—\s+—\s+—\s+—$/);
  assert.match(rows[5], /^all\s+FAIL\s+4\s+2000\s+3600\s+3600\s+3600\s+—$/);
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
  assert.equal(sql.split(" union all ").length, 4);
  assert.match(stuckRowsSql({ userId: 7, since: "2026-10-12T04:00:00Z" }), /and user_id = 7 and created_at >= '2026-10-12T04:00:00.000Z'/);
  assert.throws(() => stuckRowsSql({ userId: "1; drop table x" }), /userId/);
  assert.throws(() => stuckRowsSql({ since: "'; drop" }), /since/);
  assert.deepEqual(parseStuckRows("copy_live_setups|s1|live_setup_funding_wait|funding_submitted|2026-10-12 04:00:00\ncopy_funding_operations|f1||claimed|2026-10-12 04:00:00\n"), [
    { table: "copy_live_setups", id: "s1", issue: "live_setup_funding_wait", state: "funding_submitted", since: "2026-10-12 04:00:00" },
    { table: "copy_funding_operations", id: "f1", issue: null, state: "claimed", since: "2026-10-12 04:00:00" }]);
});
