// The gate's measurements (measure.mjs): parsing the worker log's lines, the
// database rows and the heartbeats, and their aggregation, from small fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEG_ATTEMPT_SUFFIXES, attemptDelays, claimWaitSummary, dispatchMeasures, distribution, formatMeter, heartbeatDeltas, heartbeatReading, legAttemptCloid, measureSql,
  renderMeasurements, scanMeasureLog } from "./measure.mjs";

const line = (timestamp, message, context = "CopyLiveEngine", level = "warn") => JSON.stringify({ timestamp, level, context, message });
const LEG = "2b100eb6-59f9-4cf7-8bea-30d859bffbdc|testnet:0xb56719305c461afd0de51b9e5b7146fe045553e1:530375644201373|open";
const timing = (timestamp, timings) => line(timestamp, { event: "live_execution_timing", timings, spans: [] }, "LiveExecutionRuntime", "info");
const t = (phase, stage, elapsedMs, totalMs) => ({ network: "testnet", phase, stage, elapsedMs, totalMs, clockValid: true });
const METER = { total: 899, background: 822, other: 0, live: 64, page: 12, setup: {}, markers: { setup: 1, live: 0 }, pending: [{ token: "6f4c886b", need: 635, waitingMs: 0 }], granted: [], liveNeed: 0 };
const claim = (timestamp, setupId, need, waitMs, meter) => line(timestamp, `setup ${setupId} claim waits ${JSON.stringify({ setupId, need, waitMs, ...(meter ? { meter } : {}) })}`, "CopyLiveSetupService");

const FIXTURE = [
  line("2026-10-14T10:00:00.000Z", `leg ${LEG} attempt 1 failed: live_risk_busy; elapsed 120 ms, source age 900 ms, exchange started false`),
  line("2026-10-14T10:00:00.005Z", `leg ${LEG} budget unavailable: live_risk_busy, retry 3000 ms`),
  line("2026-10-14T10:00:04.000Z", `leg ${LEG} attempt 1 failed: live_risk_stale; elapsed 500 ms, source age 4900 ms, exchange started false`),
  line("2026-10-14T10:00:08.000Z", `leg ${LEG}: attempt 1 released as never sent; planning attempt 2 of 3`, "CopyLiveEngine", "log"),
  timing("2026-10-14T10:00:09.000Z", [t("execute", "runtime_prepare", 2631, 2631), t("sign", "signer_wallet_identity", 9, 9), t("sign", "signer_local_authorization", 22, 31),
    t("sign", "signer_risk_gate", 182, 213), t("sign", "signer_approval", 120, 333), t("sign", "signer_rpc", 245, 578), t("execute", "executor_submit_gate", 242, 1051), t("execute", "executor_submit", 991, 2042)]),
  claim("2026-10-14T09:58:00.000Z", "8a79a7e0-53b6-4554-88bc-13891d209001", 635, 49560, METER),
  claim("2026-10-14T09:58:20.000Z", "8a79a7e0-53b6-4554-88bc-13891d209001", 635, 28735, METER),
  claim("2026-10-14T09:59:00.000Z", "8a79a7e0-53b6-4554-88bc-13891d209001", 81, 5000, null),
  line("2026-10-14T10:00:10.000Z", `foreign_usage_suspected ${JSON.stringify({ key: "default", ourWindowUse: 0.41, status: "429", count: 1 })}`, "HyperliquidEgress"),
  line("2026-10-14T10:00:11.000Z", `hl_ws_error_unmatched ${JSON.stringify({ text: "Unknown subscription" })}`, "HyperliquidEgress"),
  line("2026-10-14T10:00:12.000Z", "429 from Hyperliquid — backing off effective budget 360 -> 180/min", "RequestBudgeterService"),
  line("2026-10-14T10:00:12.001Z", "Hyperliquid info request rate-limited (429)", "HyperliquidInfoClient", "error"),
  line("2026-10-14T10:00:13.000Z", "Telegram getUpdates failed: 429 Too Many Requests: retry after 5.", "TelegramBotService"),
  // Not a 429: a duration that contains 429, and a weight.
  line("2026-10-14T10:00:14.000Z", "Trade analytics tracked 0xabc: 0 fills, 1 trades, 11 calls, weight 40, 7429 ms", "TradeAnalyticsService", "info"),
  // Outside the window, a non-JSON line and a line without a timestamp.
  line("2026-10-14T08:00:00.000Z", `leg ${LEG} attempt 1 failed: live_risk_busy; elapsed 1 ms, source age 1 ms, exchange started false`),
  "not json at all 429",
  JSON.stringify({ diagnostic: "local-socket-phases", firstMs: 429 }),
].join("\n");
const WINDOW = { since: Date.parse("2026-10-14T09:00:00Z"), until: Date.parse("2026-10-14T11:00:00Z") };

test("distribution: n / p50 / p95 / p99 / max, nearest rank, non-finite ignored; nulls without samples", () => {
  assert.deepEqual(distribution([]), { n: 0, p50: null, p95: null, p99: null, max: null });
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(distribution([...xs, null, NaN]), { n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
});

test("scanMeasureLog: failed attempts, budget waits, unsent releases, timings, claims and rate-limit lines inside the window", () => {
  const log = scanMeasureLog(FIXTURE, WINDOW);
  assert.deepEqual(log.failures.map((f) => [f.reason, f.attempt, f.elapsedMs, f.sourceAgeMs, f.exchangeStarted]), [["live_risk_busy", 1, 120, 900, false], ["live_risk_stale", 1, 500, 4900, false]]);
  assert.equal(log.failures[0].leg, LEG);
  assert.deepEqual(log.budgetWaits.map((b) => [b.reason, b.retryMs]), [["live_risk_busy", 3000]]);
  assert.deepEqual(log.unsentReleases.map((u) => [u.attempt, u.next, u.of]), [[1, 2, 3]]);
  assert.deepEqual(log.submits.map((s) => s.ms), [991]);
  assert.deepEqual(log.signers, [{ at: "2026-10-14T10:00:09.000Z", identityToRpcStartMs: 324, rpcMs: 245 }]);
  assert.deepEqual(log.claimWaits.map((c) => [c.need, c.waitMs, c.meter?.background ?? null]), [[635, 49560, 822], [635, 28735, 822], [81, 5000, null]]);
  assert.equal(log.rate.foreignUsageSuspected.length, 1);
  assert.equal(log.rate.foreignUsageSuspected[0].ourWindowUse, 0.41);
  assert.deepEqual(log.rate.wsErrorUnmatched.map((w) => w.text), ["Unknown subscription"]);
  assert.deepEqual(log.rate.http429.map((h) => [h.context, h.hyperliquid]), [["RequestBudgeterService", true], ["HyperliquidInfoClient", true], ["TelegramBotService", false]]);
  assert.equal(log.walletCheckedAtLogged, false);
  assert.equal(scanMeasureLog(`${FIXTURE}\n${line("2026-10-14T10:00:20.000Z", { event: "x", walletCheckedAt: 1 })}`, WINDOW).walletCheckedAtLogged, true);
});

test("attemptDelays: the next failed attempt's start (line time − elapsed), else the order's sent_at; waits told apart", () => {
  const log = scanMeasureLog(FIXTURE, WINDOW);
  const delays = attemptDelays(log.failures, { budgetWaits: log.budgetWaits, dispatches: [{ id: LEG, sentAt: "2026-10-14T10:00:08.500Z" }] });
  // 10:00:04.000 − 500 ms = 10:00:03.500, 3500 ms after the first failure; the last one → sent 4500 ms later.
  assert.deepEqual(delays.samples.map((s) => [s.reason, s.kind, s.nextMs, s.toSentMs, s.retryMs]), [["live_risk_busy", "budget_wait", 3500, null, 3000], ["live_risk_stale", "attempt", null, 4500, null]]);
  assert.deepEqual(delays.byReason.map((r) => [r.reason, r.kind, r.failures, r.legs, r.next.max, r.toSent.max]), [["live_risk_busy", "budget_wait", 1, 1, 3500, null], ["live_risk_stale", "attempt", 1, 1, null, 4500]]);
  assert.equal(delays.next.n, 1);
  // Without a dispatch (or one sent before the failure) the last failure has no next try.
  assert.equal(attemptDelays(log.failures, { dispatches: [{ id: LEG, sentAt: "2026-10-14T09:00:00.000Z" }] }).toSent.n, 0);
});

test("legAttemptCloid: pinned to apps/api copy-live-leg-attempt.ts liveSourceExecutionCloid", () => {
  // Computed from that file (node --experimental-strip-types) on 2026-10-14.
  assert.equal(legAttemptCloid("m-1", "f-1", "open", 0), "0x3ea3c8ea0d04c1f89de4cd9fd24701f6");
  assert.equal(legAttemptCloid("m-1", "f-1", "close", 2), "0x80d978ff69c79a2ba61fb3144e6151db");
  assert.equal(LEG_ATTEMPT_SUFFIXES, 3);
});

test("dispatchMeasures: POST round trips, unanswered POSTs, settled closes' attempts, suffixes used per leg", () => {
  const d = (id, leg, state, attempts, extra = {}) => ({ id, mandateId: "m-1", sourceFillId: id, leg, state, reason: null, attempts, ...extra });
  const rows = [
    d("f-1", "open", "settled", 1, { sentAt: "2026-10-14T10:00:00.000Z", ackedAt: "2026-10-14T10:00:00.800Z" }),
    d("f-2", "close", "settled", 4, { sentAt: "2026-10-14T10:01:00.000Z", ackedAt: "2026-10-14T10:01:01.200Z" }),
    d("f-3", "close", "settled", 1, { sentAt: "2026-10-14T10:02:00.000Z" }),
    d("f-4", "close", "refused", 30, { reason: "live_risk_stale" }),
    d("f-5", "open", "refused", 0, { reason: "merged_into_adjustment" }),
  ];
  const cloids = [legAttemptCloid("m-1", "f-1", "open", 0), legAttemptCloid("m-1", "f-2", "close", 0), legAttemptCloid("m-1", "f-2", "close", 1).toUpperCase(),
    legAttemptCloid("m-1", "f-3", "close", 0), legAttemptCloid("m-1", "f-3", "close", 1), legAttemptCloid("m-1", "f-3", "close", 2), "0xffffffffffffffffffffffffffffffff"];
  const m = dispatchMeasures(rows, cloids);
  assert.equal(m.legs, 5);
  assert.deepEqual([m.post.n, m.post.p50, m.post.max], [2, 800, 1200]);
  assert.equal(m.unanswered, 1);
  assert.deepEqual([m.closeAttempts.n, m.closeAttempts.max], [2, 4]);
  assert.deepEqual(m.otherCloses, { "refused:live_risk_stale": { count: 1, maxAttempts: 30 } });
  assert.deepEqual(m.legSuffixes.histogram, { 1: 1, 2: 1, 3: 1 });
  assert.deepEqual([m.legAttempts.n, m.legAttempts.max], [4, 30]);
});

test("measureSql: the run's strategies since its start, integers and an ISO time only", () => {
  const sql = measureSql({ strategyIds: [12, 13], since: "2026-10-14T10:00:00Z" });
  assert.match(sql, /from copy_live_dispatches where strategy_id in \(12,13\) and created_at >= '2026-10-14T10:00:00.000Z'/);
  assert.match(sql, /from copy_live_executions where strategy_id in \(12,13\)/);
  assert.doesNotMatch(sql, /signer_address|account_address|record|payload/);
  assert.throws(() => measureSql({ strategyIds: [], since: "2026-10-14T10:00:00Z" }), /integers/);
  assert.throws(() => measureSql({ strategyIds: ["1; drop table x"], since: "2026-10-14T10:00:00Z" }), /integers/);
  assert.throws(() => measureSql({ strategyIds: [1], since: "yesterday'" }), /ISO/);
});

test("heartbeatReading / heartbeatDeltas: foreignUsage deltas, a restart, IPs added and dropped, IPs two workers share", () => {
  const hb = (rateLimited, count, ips, role = "copy") => ({ worker: { role }, foreignUsage: { rateLimited, count, lastStatus: null }, egressIdentity: { mode: "observe", publicIps: ips } });
  const start = [heartbeatReading("http://w1", hb(2, 0, ["1.1.1.1"])), heartbeatReading("http://w2", hb(5, 1, ["2.2.2.2"], "read")), { url: "http://w3", error: "/health 503" }];
  const end = [heartbeatReading("http://w1", hb(7, 1, ["1.1.1.1", "3.3.3.3"])), heartbeatReading("http://w2", hb(1, 0, ["3.3.3.3"], "read")), heartbeatReading("http://w3", hb(0, 0, []))];
  const d = heartbeatDeltas(start, end);
  assert.deepEqual(d.rows[0], { url: "http://w1", role: "copy", rateLimited: 5, count: 1, restarted: false, start: { rateLimited: 2, count: 0 }, end: { rateLimited: 7, count: 1 },
    egressMode: "observe", publicIps: ["1.1.1.1", "3.3.3.3"], ipsAdded: ["3.3.3.3"], ipsDropped: [] });
  assert.deepEqual([d.rows[1].restarted, d.rows[1].rateLimited, d.rows[1].count, d.rows[1].ipsDropped], [true, 1, 0, ["2.2.2.2"]]);
  assert.deepEqual(d.rows[2], { url: "http://w3", error: "/health 503" });
  assert.deepEqual(d.shared, [{ ip: "3.3.3.3", urls: ["http://w1", "http://w2"] }]);
  // Egress identity off: no egressIdentity in the heartbeat.
  assert.deepEqual(heartbeatReading("http://w", { foreignUsage: { rateLimited: 0, count: 0 } }).publicIps, null);
  assert.equal(heartbeatReading("http://w", null).error, "no heartbeat body");
});

test("claimWaitSummary: per setup step from the polled stages, the longest wait and its composition", () => {
  const log = scanMeasureLog(FIXTURE, WINDOW), id = "8a79a7e0-53b6-4554-88bc-13891d209001";
  const timeline = [{ setupId: id, at: Date.parse("2026-10-14T09:57:00Z"), stage: "funded" }, { setupId: id, at: Date.parse("2026-10-14T09:58:50Z"), stage: "mode_set" }];
  const s = claimWaitSummary(log.claimWaits, timeline);
  assert.equal(s.count, 3);
  assert.equal(s.maxWaitMs, 49560);
  assert.deepEqual(s.rows.map((r) => [r.step, r.count, r.needs, r.maxWaitMs]), [["account_mode", 2, [635], 49560], ["agent", 1, [81], 5000]]);
  assert.equal(s.longest.meter.background, 822);
  // A setup the harness never polled.
  assert.deepEqual(claimWaitSummary(log.claimWaits).rows.map((r) => r.step), ["unknown"]);
  assert.match(formatMeter(METER), /^total 899: background 822, live 64, page 12, other 0, setup \{\}, markers setup 1 \/ live 0, pending \[6f4c886b need 635 waiting 0 ms\], granted \[\], liveNeed 0$/);
  assert.equal(formatMeter(null), "no composition logged");
});

test("renderMeasurements: one separated block, every section, notes where a source is missing", () => {
  const log = scanMeasureLog(FIXTURE, WINDOW);
  const text = renderMeasurements({ window: { from: "a", to: "b" }, log, delays: attemptDelays(log.failures, { budgetWaits: log.budgetWaits }), claims: claimWaitSummary(log.claimWaits),
    db: null, dbNote: "no copy ran in this run", health: null, healthNote: "no start reading" });
  for (const heading of ["MEASUREMENTS (recorded, not pass/fail", "1a. exchange POST", "1b. close attempts", "1c. leg attempts", "1d. failed leg attempt", "1e. signer walletCheckedAt", "2. rate limits", "3. setup claim waits"])
    assert.ok(text.includes(heading), heading);
  assert.match(text, /database: no copy ran in this run/);
  assert.match(text, /walletCheckedAt logged: NO/);
  assert.match(text, /needs an api change/);
  assert.match(text, /foreign_usage_suspected 1, hl_ws_error_unmatched 1, HTTP 429 3 \(Hyperliquid 2/);
  assert.match(text, /3 claim wait line\(s\), longest 49560 ms/);
  assert.doesNotMatch(text, /postgres(ql)?:\/\//);
});

test("scanMeasureLog and renderMeasurements: the observer's evidence_expired lines, by check and reason", () => {
  const expired = (timestamp, body) => line(timestamp, `live_account_evidence_expired ${JSON.stringify(body)}`, "LiveAccountObserver");
  const text = [
    expired("2026-10-14T10:00:01.000Z", { check: "provider_state_time", reason: "older_than_bound", ageMs: 5120, maxAgeMs: 5000 }),
    expired("2026-10-14T10:00:02.000Z", { check: "provider_state_time", reason: "older_than_bound", ageMs: 5400, maxAgeMs: 5000 }),
    expired("2026-10-14T10:00:03.000Z", { check: "final", reason: "ahead_of_clock", ageMs: -12, maxAgeMs: 5000 }),
    expired("2026-10-14T11:00:00.000Z", { check: "final", reason: "older_than_bound", ageMs: 9000, maxAgeMs: 5000 }),
  ].join("\n");
  const log = scanMeasureLog(text, { since: Date.parse("2026-10-14T10:00:00.000Z"), until: Date.parse("2026-10-14T10:30:00.000Z") });
  assert.deepEqual(log.expired.map((x) => [x.check, x.reason, x.ageMs]), [["provider_state_time", "older_than_bound", 5120], ["provider_state_time", "older_than_bound", 5400], ["final", "ahead_of_clock", -12]]);
  const out = renderMeasurements({ window: { from: "a", to: "b" }, log, delays: attemptDelays([]), claims: claimWaitSummary([]) });
  assert.match(out, /live_account_evidence_expired: 3 \(provider_state_time older_than_bound ×2, max age 5400 ms; final ahead_of_clock ×1, max age -12 ms\)/);
});

import { workerRolesLabel } from "./measure.mjs";
test("workerRolesLabel: an all-role worker is named beside the local-bucket waits; copy + read is Stage's split", () => {
  const copy = "http://localhost:3010", read = "http://localhost:3011";
  const all = workerRolesLabel([{ url: copy, role: "all" }], { copy, read: null });
  assert.equal(all.split, false);
  assert.match(all.label, /^all-role worker http:\/\/localhost:3010: TradeAnalytics \/ Cohort \/ Leaderboard reads drain the same local bucket as the orders \(roles not split/);
  const split = workerRolesLabel([{ url: copy, role: "copy" }, { url: read, role: "read" }], { copy, read });
  assert.deepEqual(split, { split: true, copyRole: "copy", readRole: "read", label: `roles split: copy worker ${copy}, read worker ${read} (as on Stage)` });
  // A copy worker whose read worker is down (or unread) is not the split.
  const half = workerRolesLabel([{ url: copy, role: "copy" }, { url: read, error: "/health 503" }], { copy, read });
  assert.equal(half.split, false);
  assert.match(half.label, /worker http:\/\/localhost:3010 role copy, read worker http:\/\/localhost:3011 role unknown/);
  assert.match(workerRolesLabel([], { copy, read: null }).label, /role unknown \(no heartbeat role\)$/);
  // The block names it on the local-bucket waits' section (1d), and says nothing when the run has no roles reading.
  const base = { window: { from: "a", to: "b" }, log: null, delays: null, claims: null };
  assert.match(renderMeasurements({ ...base, roles: all }), /1d\. failed leg attempt[^\n]*\n  local-bucket waits measured on: all-role worker/);
  assert.doesNotMatch(renderMeasurements(base), /local-bucket waits measured on/);
});
