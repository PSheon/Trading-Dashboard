// The mainnet evidence probe's analysis (mainnet-evidence-probe.mjs), offline,
// from small fixtures. Not in CI's script tests (they list their files); run
// with `node --test scripts/copy-harness/mainnet-evidence-probe.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateRuns, analyzeRun, fillIndexLag, isotonic, quotaSpans, renderReport, spread, unionMs } from "./mainnet-evidence-probe.mjs";

test("unionMs merges overlapping and touching intervals", () => {
  assert.equal(unionMs([[0, 10], [5, 15], [20, 25], [25, 30], [40, 40]]), 25);
  assert.equal(unionMs([]), 0);
});

test("spread: nearest-rank p50 / p95 / max, nulls for no samples", () => {
  assert.deepEqual(spread([5, 1, 3, 2, 4]), { n: 5, p50: 3, p95: 5, max: 5 });
  assert.deepEqual(spread([null, NaN]), { n: 0, p50: null, p95: null, max: null });
});

test("quotaSpans splits the meter's spans at the evidence clock, a straddling span by its parts", () => {
  const spans = [
    { name: "quota_rest_queue", atMs: 0, ms: 5 }, { name: "quota_rest_tx", atMs: 5, ms: 40 }, { name: "quota_rest_lock", atMs: 10, ms: 8 },
    { name: "rest_wave_quota", atMs: 0, ms: 45 }, // not a meter span itself
    { name: "quota_subscribe_queue", role: "follower", atMs: 100, ms: 30 }, { name: "quota_subscribe_tx", role: "follower", atMs: 130, ms: 50 },
    { name: "quota_connect_tx", role: "leader", atMs: 150, ms: 50 },
  ];
  const { inClock, beforeClock } = quotaSpans(spans, 25);
  assert.equal(beforeClock.requests, 1);
  assert.equal(beforeClock.txMs, 20); // 5..25 of the rest tx
  assert.equal(beforeClock.wallMs, 25);
  assert.equal(inClock.requests, 3);
  assert.equal(inClock.txMs, 20 + 50 + 50);
  assert.equal(inClock.queueMs, 30);
  assert.equal(inClock.lockMs, 0); // the lock ended before the clock
  assert.equal(inClock.wallMs, 20 + 100); // 25..45 and 100..200
  assert.deepEqual(inClock.byKind.subscribe, { requests: 1, txMs: 50, queueMs: 30, lockMs: 0 });
});

const raw = (run, overrides = {}) => ({
  run, case: "open", ok: true, collectAtMs: 0, collectEndAtMs: 1000, clockAtMs: 200, dexes: 11, sentWeight: 300, paidWeight: 300,
  timings: [{ phase: "collect", stage: "epoch_local_authority", elapsedMs: 30 }, { phase: "collect", stage: "epoch_first_wave", elapsedMs: 400 }, { phase: "hold", stage: "risk_local_read", elapsedMs: 9 }],
  spans: [{ name: "quota_rest_tx", atMs: 100, ms: 50 }, { name: "quota_subscribe_tx", role: "follower", atMs: 300, ms: 40 }, { name: "observer_ws", role: "follower", atMs: 250, ms: 600 }],
  rest: [{ type: "userRole", weight: 60, status: 200, ms: 100 }, { type: "perpDexs", weight: 20, status: 200, ms: 90 }],
  ws: { sockets: 2, subscribes: 24, unsubscribes: 0, other: 0, framesIn: 50, bytesIn: 9000 },
  ...overrides,
});

test("analyzeRun: collect time, the age at return, the collect stages, REST weight by type, the meter in the clock", () => {
  const r = analyzeRun(raw(1));
  assert.equal(r.collectMs, 1000);
  assert.equal(r.evidenceAgeMs, 800);
  assert.equal(r.preClockMs, 200);
  assert.deepEqual(r.stages, { epoch_local_authority: 30, epoch_first_wave: 400 });
  assert.equal(r.rest.weight, 80);
  assert.deepEqual(r.rest.byType.userRole, { requests: 1, weight: 60 });
  assert.equal(r.quota.inClock.requests, 1);
  assert.equal(r.quota.inClock.txMs, 40);
  assert.equal(r.quota.beforeClock.txMs, 50);
  assert.equal(r.fillIndexReadMs, 0);
  assert.equal(r.spans.find((s) => s.span === "observer_ws:follower").totalMs, 600);
});

test("aggregateRuns: p50 / p95 / max over the ok runs only; errors listed", () => {
  const runs = [analyzeRun(raw(1)), analyzeRun(raw(2, { collectEndAtMs: 3000 })), analyzeRun(raw(3, { ok: false, error: "live_risk_stale", collectEndAtMs: 9000 }))];
  const a = aggregateRuns(runs);
  assert.equal(a.ok, 2);
  assert.deepEqual(a.errors, [{ run: 3, error: "live_risk_stale" }]);
  assert.deepEqual(a.collectMs, { n: 2, p50: 1000, p95: 3000, max: 3000 });
  assert.deepEqual(a.quotaInClock.txMs, { n: 2, p50: 40, p95: 40, max: 40 });
  assert.deepEqual(a.wsSubscribes, { n: 2, p50: 24, p95: 24, max: 24 });
  assert.deepEqual(a.dexes, [11]);
  const text = renderReport({ config: { follower: "0xf", leader: "0xl", coin: "ETH", dbRttMs: 8, paceMs: 65000 }, cases: { open: { runs: [raw(1), raw(2)] } } });
  assert.match(text, /CASE open: 2\/2 runs ok/);
  assert.match(text, /quota SQL in clock: Σ tx ms/);
});

test("isotonic: pools adjacent violators into their mean", () => {
  assert.deepEqual(isotonic([0, 1, 0, 1, 1]), [0, 0.5, 0.5, 1, 1]);
  assert.deepEqual(isotonic([1, 0, 0]), [1 / 3, 1 / 3, 1 / 3]);
});

test("fillIndexLag: quantiles from inclusion by age, per-fill brackets", () => {
  // Every fill is indexed exactly 1500 ms after its time; polls every 1000 ms
  // with a 60 s window (sentAt = receivedAt − 100).
  const fills = Array.from({ length: 40 }, (_, i) => ({ tid: i, time: 10_000 + i * 250 }));
  const polls = Array.from({ length: 80 }, (_, k) => {
    const sentAt = 10_000 + k * 1000;
    return { sentAt, receivedAt: sentAt + 100, startTime: sentAt - 60_000, tids: fills.filter((x) => x.time + 1500 <= sentAt).map((x) => x.tid) };
  });
  const lag = fillIndexLag(polls, fills, { settleMs: 30_000 });
  assert.equal(lag.fills, 40);
  assert.equal(lag.lagMs.p50, 1500);
  assert.equal(lag.lagMs.p99, 1500);
  assert.ok(lag.maxAgeExcluded < 1500);
  // The first poll that returned it is at most one poll interval (+ its 100 ms) past the lag.
  assert.ok(lag.upperMs.max <= 1500 + 1000 + 100 && lag.upperMs.p50 >= 1500);
  assert.ok(lag.lowerMs.max < 1500);
});

test("analyzeRun: the boundary reads after collect are counted apart from collect's REST and meter", () => {
  const r = analyzeRun(raw(1, {
    spans: [...raw(1).spans, { name: "quota_rest_tx", atMs: 1010, ms: 30 }, { name: "quota_rest_tx", atMs: 1100, ms: 30 }],
    rest: [...raw(1).rest, { type: "extraAgents", weight: 20, status: 200, ms: 90, boundary: true }],
    boundary: { atMs: 1000, endAtMs: 1300, reads: [{ type: "extraAgents", ms: 90, status: 200 }, { type: "extraAgents", ms: 120, status: 200 }] },
  }));
  assert.equal(r.rest.weight, 80);
  assert.equal(r.quota.inClock.requests, 1); // collect's only: the clock side ends at collect's return
  assert.equal(r.boundary.ms, 300);
  assert.equal(r.boundary.quota.requests, 2);
  assert.equal(r.boundary.quota.txMs, 60);
  assert.equal(r.providerAgeMs, 1100);
  const a = aggregateRuns([r]);
  assert.deepEqual(a.boundaryReads.extraAgents, { n: 1, p50: 120, p95: 120, max: 120 });
});
