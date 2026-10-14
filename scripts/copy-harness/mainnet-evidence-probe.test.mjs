// The mainnet evidence probe's analysis (mainnet-evidence-probe.mjs), offline,
// from small fixtures. Not in CI's script tests (they list their files); run
// with `node --test scripts/copy-harness/mainnet-evidence-probe.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateRuns, analyzeRun, changedPaths, fillIndexLag, freshnessCallSite, freshnessReason, freshnessTable, isotonic, observationDiffs, quotaSpans, renderReport, spread, stateTimeLags, unionMs } from "./mainnet-evidence-probe.mjs";

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

test("changedPaths: key paths of a difference, array elements by name, never a value", () => {
  const before = [null, { name: "xyz", fullName: "XYZ", assetToStreamingOiCap: [["xyz:ETH", "100"], ["xyz:BTC", "5"]] }];
  const after = [null, { name: "xyz", fullName: "XYZ", assetToStreamingOiCap: [["xyz:ETH", "101"], ["xyz:BTC", "5"]] }];
  assert.deepEqual(changedPaths(before, after), ["[xyz].assetToStreamingOiCap[xyz:ETH][1]"]);
  assert.deepEqual(changedPaths(before, after, { depth: 3 }), ["[xyz].assetToStreamingOiCap[xyz:ETH]"]);
  assert.deepEqual(changedPaths({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(changedPaths(1, 2), ["(whole answer)"]);
  assert.doesNotMatch(JSON.stringify(changedPaths({ balances: [{ coin: "USDC", total: "secret-1" }] }, { balances: [{ coin: "USDC", total: "secret-2" }] })), /secret/);
});

test("observationDiffs: per read and account, first answer against the last; the leader's spot state by portfolio margin alone", () => {
  const answers = [
    { type: "perpDexs", account: "-", value: [null, { name: "xyz", oi: "1" }] },
    { type: "spotClearinghouseState", account: "follower", value: { balances: [{ coin: "USDC", total: "1" }] } },
    { type: "spotClearinghouseState", account: "leader", value: { balances: [], portfolioMarginEnabled: false } },
    { type: "perpDexs", account: "-", value: [null, { name: "xyz", oi: "2" }] },
    { type: "spotClearinghouseState", account: "follower", value: { balances: [{ coin: "USDC", total: "1" }] } },
    { type: "spotClearinghouseState", account: "leader", value: { balances: [{ coin: "HYPE", total: "3" }], portfolioMarginEnabled: false } },
  ];
  assert.deepEqual(observationDiffs(answers, ["perpDexs", "spotClearinghouseState"]),
    [{ read: "perpDexs", account: "-", scope: "account-independent", answers: 2, paths: ["[xyz].oi"] }]);
  assert.deepEqual(observationDiffs(answers, ["userRole"]), []);
  const text = renderReport({ cases: { open: { runs: [raw(1, { ok: false, error: "live_account_observation_changed",
    observationChange: { changedReads: ["perpDexs"], diffs: observationDiffs(answers, ["perpDexs"]) } })] } } });
  assert.match(text, /#1 changed perpDexs = perpDexs\/- \(account-independent\): \[xyz\]\.oi/);
  assert.match(text, /by read: perpDexs\/- \(account-independent\) ×1/);
});

test("freshnessCallSite: names the observer's check by its source text and line, the per-read deadline apart", () => {
  const lines = [
    "      this.fresh(started);",
    "        const remaining = () => { this.fresh(started); return 1; };",
    "        this.fresh(proof.observedAt); this.fresh(started);",
    "        this.freshProvider(state.time);",
  ];
  const at = (line, column) => `Error\n    at wrapper (/x/test/spec.ts:6:88)\n    at observeInternal (/x/src/copy/live/live-account-observer.ts:${line}:${column})`;
  assert.equal(freshnessCallSite(at(1, 12), lines), "fresh(started)@L1");
  assert.equal(freshnessCallSite(at(2, 40), lines), "remaining:fresh(started)@L2");
  assert.equal(freshnessCallSite(at(3, 14), lines), "fresh(proof.observedAt)@L3");
  assert.equal(freshnessCallSite(at(3, 44), lines), "fresh(started)@L3");
  assert.equal(freshnessCallSite(at(4, 14), lines), "freshProvider(state.time)@L4");
  assert.equal(freshnessCallSite("Error\n    at elsewhere (/x/a.ts:1:1)", lines), null);
});

test("freshnessReason: as the observer refuses (a provider time may run ahead by the skew)", () => {
  const c = (kind, at, now) => freshnessReason({ kind, at, now, maxAgeMs: 5000, skewMs: 2000 });
  assert.equal(c("fresh", 1000, 6000), null);
  assert.equal(c("fresh", 1000, 6001), "older_than_bound");
  assert.equal(c("fresh", 1001, 1000), "ahead_of_clock");
  assert.equal(c("freshProvider", 2999, 1000), null);
  assert.equal(c("freshProvider", 3001, 1000), "ahead_of_clock");
  assert.equal(c("freshProvider", 1000, 6001), "older_than_bound");
  assert.equal(c("fresh", -1, 1000), "negative");
  assert.equal(c("fresh", 1.5, 1000), "not_integer");
});

test("freshnessTable, stateTimeLags and the report: which check refused, its age, each check's largest age", () => {
  const checks = [{ site: "fresh(started)@L226", role: "follower", ageMs: 0, ok: true }, { site: "fresh(started)@L226", role: "follower", ageMs: 40, ok: true },
    { site: "freshProvider(state.time)@L356", role: "leader", ageMs: 5100, ok: false }];
  assert.deepEqual(freshnessTable(checks), [
    { site: "fresh(started)@L226", role: "follower", n: 2, minAgeMs: 0, maxAgeMs: 40, refused: 0 },
    { site: "freshProvider(state.time)@L356", role: "leader", n: 1, minAgeMs: 5100, maxAgeMs: 5100, refused: 1 }]);
  const lags = stateTimeLags({ clearinghouseStates: [["", { time: 9000 }], ["xyz", { time: 4000 }], ["abc", {}]] }, 9500);
  assert.deepEqual(lags, { dexes: 2, maxLagMs: 5500, maxLagDex: "xyz", minLagMs: 500, minLagDex: "" });
  assert.equal(stateTimeLags({ clearinghouseStates: [] }, 1), null);
  const failure = { site: "freshProvider(state.time)@L356", kind: "freshProvider", role: "leader", ageMs: 5100, maxAgeMs: 5000, skewMs: 2000, reason: "older_than_bound" };
  const text = renderReport({ cases: { open: { runs: [
    raw(1, { freshness: { checks: freshnessTable(checks.slice(0, 2)), failures: [] }, stateLags: [{ role: "leader", ...lags }], wallDriftMs: -2 }),
    raw(2, { ok: false, error: "live_account_evidence_expired", freshness: { checks: freshnessTable(checks), failures: [failure] }, stateLags: [], wallDriftMs: 1 }),
  ] } } });
  assert.match(text, /freshness refusals \(1\):\n {4}#2 freshProvider\(state\.time\)@L356 leader: age 5100 ms \(bound 5000, ahead allowed 2000\) older_than_bound/);
  assert.match(text, /fresh\(started\)@L226 follower +40 \/ 40 \/ 40 +min 0 +refused 0\/2 runs/);
  assert.match(text, /snapshot state time lag leader .*largest per run 5500 \/ 5500 \/ 5500, smallest 500; largest on xyz ×1/);
  assert.match(text, /\|wall − monotonic clock\| over a run \(ms\) +1 \/ 2 \/ 2/);
});
