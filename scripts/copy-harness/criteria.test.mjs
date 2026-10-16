// The gate's two-part criteria (criteria.mjs) and the harness_timing rule (checks.mjs),
// on gate run 9's real numbers (2026-10-14T08-48-44-160Z: summary, new_coin evidence and
// reconcile files, the worker log, strategy 129's dispatch rows, the testnet fills).
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, positionBefore } from "./checks.mjs";
import { FIXED_SUBSCRIPTIONS, MAINNET_DEXES, dexFanout, evidenceDetail, fanoutShare, harnessTimingCause, judgeOrders, judgedStats, signalLatency } from "./criteria.mjs";
import { renderGateSummary } from "./lib.mjs";

/** Gate 9's one order (new-coin, BTC open, 2026-10-14T08:53:54.456Z): evidence 4256 ms, its spans as logged. */
const span = (span, count, totalMs, maxMs, firstAtMs, lastEndMs) => ({ span, count, totalMs, maxMs, firstAtMs, lastEndMs });
const GATE9_ORDER = Object.freeze({
  at: "2026-10-14T08:53:54.456Z", network: "testnet", evidenceMs: 4256, orderMs: 5234, submitted: true,
  phases: { prepare: 2896, collect: 2576, execute: 3120, hold: 163, sign: 659, submit: 168 },
  spans: [
    span("quota_rest_queue", 5, 1, 1, 278, 4353), span("quota_rest_tx", 5, 272, 68, 278, 4404), span("rest_wave_quota", 3, 172, 68, 278, 2717),
    span("rest_wave_http", 3, 267, 126, 328, 2791), span("observer_rest:follower", 1, 196, 196, 406, 602), span("observer_rest:leader", 1, 196, 196, 406, 602),
    span("ws_reserve:follower", 3, 327, 163, 608, 772), span("observer_ws:follower", 1, 1696, 1696, 608, 2304),
    span("ws_reserve:leader", 3, 816, 321, 610, 931), span("observer_ws:leader", 1, 2036, 2036, 610, 2646),
    span("ws_open:follower", 3, 455, 155, 667, 921), span("quota_subscribe_queue:follower", 3, 800, 268, 667, 1044), span("ws_subscribe_quota:follower", 3, 977, 331, 667, 1104),
    span("ws_open:leader", 3, 480, 174, 833, 1084), span("ws_subscribe_quota:leader", 3, 1326, 505, 833, 1437), span("quota_subscribe_queue:leader", 3, 1150, 446, 836, 1380),
    span("quota_subscribe_tx:follower", 3, 170, 60, 931, 1104), span("quota_subscribe_lock:follower", 3, 27, 9, 943, 1064),
    span("quota_opened_queue:leader", 3, 1359, 467, 986, 1552), span("ws_first_message:follower", 1, 150, 150, 987, 1137), span("ws_messages:follower", 3, 3223, 1085, 987, 2170),
    span("quota_subscribe_tx:leader", 3, 170, 57, 1155, 1436), span("quota_subscribe_lock:leader", 3, 27, 9, 1165, 1398),
    span("ws_first_message:leader", 1, 141, 141, 1212, 1353), span("ws_messages:leader", 3, 3192, 1084, 1212, 2521),
    span("ws_close:follower", 3, 382, 133, 2072, 2302), span("ws_close:leader", 3, 342, 123, 2274, 2644),
  ],
});
/** Testnet's perpDexs had 270 entries (the main dex and 269 HIP-3 dexes) when gate 9 ran; mainnet's 11. */
const GATE9_DEXES = Object.freeze({ venues: 270, mainnetDexes: MAINNET_DEXES });

test("fanoutShare: every venue's openOrders plus the aggregate state; all but the state and the main dex are fan-out", () => {
  assert.equal(FIXED_SUBSCRIPTIONS, 2);
  assert.deepEqual(fanoutShare(270), { subscriptions: 271, fanout: 269, share: 269 / 271 });
  assert.deepEqual(fanoutShare(11), { subscriptions: 12, fanout: 10, share: 10 / 12 });
  assert.equal(fanoutShare(1).fanout, 0);
  for (const bad of [0, -1, 1.5, null, undefined, NaN]) assert.equal(fanoutShare(bad), null);
});

test("dexFanout on gate 9: 4256 ms raw → 2763 ms without the fan-out; 16.65 ms/dex; 2930 ms projected to 11 mainnet dexes", () => {
  const f = dexFanout(GATE9_ORDER, GATE9_DEXES);
  assert.equal(f.applied, true);
  assert.equal(f.rawMs, 4256);
  // Per role: (ws_messages + quota_subscribe_queue + quota_subscribe_tx) / 3 sockets, × 269/271.
  assert.deepEqual(f.roles, [
    { role: "follower", sockets: 3, endMs: 2304, subscribePathMs: 1398, fanoutMs: 1387 },
    { role: "leader", sockets: 3, endMs: 2646, subscribePathMs: 1504, fanoutMs: 1493 },
  ]);
  // The leader's observation ends last (2646); without the fan-out it would end at 1153, the follower's at 917.
  assert.equal(f.criticalRole, "leader");
  assert.equal(f.fanoutMs, 1493);
  assert.equal(f.adjustedMs, 2763);
  assert.equal(f.judgedMs, 2763);
  // 269 fan-out venues over 3 sockets: 89.7 per socket; 1493 / 89.7.
  assert.equal(f.unitMsPerDex, 16.65);
  // One mainnet socket carries its 10 HIP-3 dexes: 2763 + 10 × 16.65.
  assert.equal(f.projectedMainnetMs, 2930);
  // --mainnet-dexes 20: 2763 + 19 × 16.65.
  assert.equal(dexFanout(GATE9_ORDER, { venues: 270, mainnetDexes: 20 }).projectedMainnetMs, 3079);
});

test("dexFanout judges the raw number on mainnet and whenever the network or the venue count is unknown", () => {
  for (const [order, dexes, reason] of [
    [{ ...GATE9_ORDER, network: "mainnet" }, GATE9_DEXES, /mainnet/],
    [{ ...GATE9_ORDER, network: null }, GATE9_DEXES, /network unknown/],
    [GATE9_ORDER, { venues: null }, /dex count unknown/],
  ]) {
    const f = dexFanout(order, dexes);
    assert.equal(f.applied, false);
    assert.equal(f.judgedMs, 4256);
    assert.match(f.reason, reason);
  }
  // No WS observation in the order: nothing to remove.
  const none = dexFanout({ ...GATE9_ORDER, spans: GATE9_ORDER.spans.filter((s) => !s.span.startsWith("observer_ws")) }, GATE9_DEXES);
  assert.equal(none.fanoutMs, 0);
  assert.equal(none.judgedMs, 4256);
  // The removal never exceeds a role's own observation, nor the evidence.
  const tiny = dexFanout({ ...GATE9_ORDER, evidenceMs: 1000 }, GATE9_DEXES);
  assert.equal(tiny.fanoutMs, 1000);
  assert.equal(tiny.adjustedMs, 0);
});

test("gate 9's new_coin_evidence_under_3500ms under the new criteria: judged 2763 ms passes; raw 4256 stays in the detail and the table", () => {
  const orders = judgeOrders([GATE9_ORDER], GATE9_DEXES);
  const stats = judgedStats(orders, 3500);
  assert.equal(stats.over, 0);
  assert.deepEqual(stats.judged, { p50: 2763, p95: 2763, max: 2763 });
  assert.deepEqual(stats.raw, { p50: 4256, p95: 4256, max: 4256 });
  assert.deepEqual(stats.projectedMainnet, { p50: 2930, p95: 2930, max: 2930 });
  const detail = evidenceDetail(orders, 3500, GATE9_DEXES);
  assert.match(detail, /^evidence window 5000 ms \(mainnet's\): 1 order\(s\), judged p50 2763 \/ p95 2763 \/ max 2763 ms, 0 at or over 3500/);
  // Under the testnet allowance (stage-like, 7000) the same figures say so; the judged limit stays 3500.
  assert.match(evidenceDetail(orders, 3500, GATE9_DEXES, 7000), /^evidence window 7000 ms \(TESTNET allowance, not mainnet-equivalent; mainnet stays 5000\): 1 order\(s\), judged p50 2763 .* 0 at or over 3500/);
  assert.match(detail, /raw p50 4256 \/ p95 4256 \/ max 4256 ms/);
  assert.match(detail, /dex fan-out \(270 venues\): fan-out p50 1493 \/ p95 1493 \/ max 1493 ms, 16\.65 ms\/dex/);
  assert.match(detail, /mainnet projection \(11 dexes\) p50 2930 \/ p95 2930 \/ max 2930 ms/);
  // The same order on a mainnet run: judged raw, and it fails.
  const mainnet = judgeOrders([{ ...GATE9_ORDER, network: "mainnet" }], GATE9_DEXES);
  assert.equal(judgedStats(mainnet, 3500).over, 1);
  assert.match(evidenceDetail(mainnet, 3500, GATE9_DEXES), /judged = raw \(mainnet: raw evidence\)/);
  const table = renderGateSummary([{ name: "new-coin", ok: true, orders }]).split("\n");
  assert.match(table[2], /^new-coin\s+PASS\s+1\s+2763\s+2763\s+2763\s+4256\s+2930\s+5000$/);
});

// Gate 9's dispatch rows (strategy 129) and the leader's testnet fills.
const T = (iso) => Date.parse(iso);
const GATE9_DISPATCHES = [
  { id: "d-btc-merged", tid: "18476039263359", leg: "open", coin: "BTC", state: "refused", reason: "merged_into_adjustment", adjustmentId: "d-btc", cloid: "", executionState: "",
    leaderTime: T("2026-10-14T08:52:45.957Z"), receivedAt: T("2026-10-14T08:53:45.765Z"), createdAt: T("2026-10-14T08:53:45.888Z"), sentAt: 0 },
  { id: "d-btc", tid: "633915389062677", leg: "open", coin: "BTC", state: "settled", reason: "", adjustmentId: "", cloid: "0xee925e3a6ebcfc17b55b28da0c0d77b8", executionState: "filled",
    leaderTime: T("2026-10-14T08:52:45.957Z"), receivedAt: T("2026-10-14T08:53:45.766Z"), createdAt: T("2026-10-14T08:53:45.888Z"), sentAt: T("2026-10-14T08:53:53.514Z") },
  { id: "d-eth", tid: "376714332725728", leg: "open", coin: "ETH", state: "refused", reason: "signal_expired", adjustmentId: "", cloid: "", executionState: "",
    leaderTime: T("2026-10-14T08:53:58.260Z"), receivedAt: T("2026-10-14T08:55:45.864Z"), createdAt: T("2026-10-14T08:55:45.974Z"), sentAt: 0 },
];
const fill = (coin, side, sz, time, oid, tid, startPosition) => ({ coin, side, sz, px: "1", time: T(time), oid, tid, startPosition });
const GATE9_LEADER_FILLS = [
  fill("BTC", "B", "0.00006", "2026-10-14T08:52:45.957Z", 62677433636, 18476039263359, "0.0"),
  fill("BTC", "B", "0.00018", "2026-10-14T08:52:45.957Z", 62677433636, 633915389062677, "0.00006"),
  fill("ETH", "B", "0.008", "2026-10-14T08:53:58.260Z", 62677507692, 376714332725728, "0.0"),
  fill("ETH", "A", "0.008", "2026-10-14T08:56:05.584Z", 62677629315, 911707038091046, "0.008"),
  fill("BTC", "A", "0.00024", "2026-10-14T08:56:12.337Z", 62677635502, 1081428496188577, "0.00024"),
];
const GATE9_FOLLOWER_FILLS = [{ coin: "BTC", side: "B", sz: "0.00019", px: "83306.0", time: T("2026-10-14T08:53:53.990Z"), oid: 62677502478, tid: 292248209395513, startPosition: "0.0", cloid: "0xee925e3a6ebcfc17b55b28da0c0d77b8" }];
/** The reconcile ran at 08:56:18.448 (the window's end); the stream's last completed read covered through 08:55:44.575. */
const gate9 = (sourceTiming) => evaluate({ leaderFills: GATE9_LEADER_FILLS, dispatches: GATE9_DISPATCHES, followerFills: GATE9_FOLLOWER_FILLS,
  leaderPositions: new Map(), followerPositions: new Map([["BTC", 0.00019]]), followerLeverage: new Map([["BTC", 3]]), rules: { maxLeverage: 3 }, sourceTiming });

test("signalLatency on gate 9: fill → dispatch created 59.93 s p50 / 107.71 s max (the 60 s testnet poll); created → sent 7.63 s (ours)", () => {
  assert.deepEqual(signalLatency(GATE9_DISPATCHES), {
    leaderToCreated: { n: 3, p50: 59.93, p95: 107.71, max: 107.71 },
    createdToSent: { n: 1, p50: 7.63, p95: 7.63, max: 7.63 },
  });
  // Without created_at (an older row source), the received time stands in.
  assert.equal(signalLatency([{ leaderTime: 1000, receivedAt: 3000, sentAt: 4000 }]).createdToSent.p50, 1);
  assert.deepEqual(signalLatency([]), { leaderToCreated: { n: 0, p50: null, p95: null, max: null }, createdToSent: { n: 0, p50: null, p95: null, max: null } });
});

test("harnessTimingCause: the stream's coverage decides when it is read; the end minus one poll otherwise", () => {
  const covered = T("2026-10-14T08:55:44.575Z");
  assert.deepEqual(harnessTimingCause(T("2026-10-14T08:56:05.584Z"), { coverageThrough: covered }), { rule: "after_last_source_read", coverageThrough: "2026-10-14T08:55:44.575Z" });
  assert.equal(harnessTimingCause(covered, { coverageThrough: covered }), null);
  // Coverage wins over the poll window: covered and without a dispatch is never harness timing.
  assert.equal(harnessTimingCause(T("2026-10-14T08:55:40Z"), { coverageThrough: covered, endAt: T("2026-10-14T08:56:18.448Z"), pollMs: 60_000 }), null);
  const end = { coverageThrough: null, endAt: T("2026-10-14T08:56:18.448Z"), pollMs: 60_000 };
  assert.equal(harnessTimingCause(T("2026-10-14T08:56:05.584Z"), end).rule, "within_last_poll_interval");
  assert.equal(harnessTimingCause(T("2026-10-14T08:55:18.448Z"), end), null);
  assert.equal(harnessTimingCause(T("2026-10-14T08:56:05.584Z"), null), null);
  assert.equal(harnessTimingCause(T("2026-10-14T08:56:05.584Z"), { endAt: T("2026-10-14T08:56:18.448Z") }), null);
});

test("gate 9's new_coin_reconcile: both closes and BTC's direction are harness_timing; the ETH open's signal_expired still FAILS", () => {
  const r = gate9({ coverageThrough: T("2026-10-14T08:55:44.575Z"), endAt: T("2026-10-14T08:56:18.448Z"), pollMs: 60_000 });
  assert.deepEqual(r.failures.map((f) => f.check), ["signal_expired"]);
  assert.deepEqual(r.harnessTiming.map((h) => [h.check, h.coin, h.cause?.rule ?? null]), [
    ["leader_order_without_dispatch", "ETH", "after_last_source_read"],
    ["leader_order_without_dispatch", "BTC", "after_last_source_read"],
    ["direction_mismatch", "BTC", null],
  ]);
  const btc = r.harnessTiming.find((h) => h.check === "direction_mismatch");
  assert.deepEqual([btc.leader, btc.follower, btc.leaderBefore, btc.after.oid], [0, 0.00019, 0.00024, 62677635502]);
  // No coverage row: the same orders fall in the last 60 s poll interval before the end.
  assert.deepEqual(gate9({ coverageThrough: null, endAt: T("2026-10-14T08:56:18.448Z"), pollMs: 60_000 }).harnessTiming.map((h) => h.check),
    ["leader_order_without_dispatch", "leader_order_without_dispatch", "direction_mismatch"]);
});

test("a leader order a completed source read covered, with no dispatch, remains a FAIL (and so does its direction)", () => {
  const r = gate9({ coverageThrough: T("2026-10-14T08:56:15Z"), endAt: T("2026-10-14T08:56:18.448Z"), pollMs: 60_000 });
  assert.deepEqual(r.failures.map((f) => [f.check, f.coin ?? null]), [["leader_order_without_dispatch", "ETH"], ["leader_order_without_dispatch", "BTC"], ["signal_expired", null], ["direction_mismatch", "BTC"]]);
  assert.deepEqual(r.harnessTiming, []);
  // Coverage between the two closes: the ETH close FAILS, the BTC close is harness timing.
  const split = gate9({ coverageThrough: T("2026-10-14T08:56:10Z") });
  assert.deepEqual(split.failures.map((f) => [f.check, f.coin ?? null]), [["leader_order_without_dispatch", "ETH"], ["signal_expired", null]]);
  assert.deepEqual(split.harnessTiming.map((h) => [h.check, h.coin]), [["leader_order_without_dispatch", "BTC"], ["direction_mismatch", "BTC"]]);
  // A 3 s poll and no coverage row: 08:56:05 and 08:56:12 were due a read before 08:56:15.448.
  assert.deepEqual(gate9({ endAt: T("2026-10-14T08:56:18.448Z"), pollMs: 3000 }).harnessTiming, []);
  // Without any source timing (an older caller), nothing changes.
  assert.equal(gate9(undefined).failures.length, 4);
});

test("a direction mismatch the unread order does not explain still FAILS", () => {
  // The follower is short while the leader was long before its unread close: not the copy's last read.
  const r = evaluate({ leaderFills: GATE9_LEADER_FILLS, dispatches: GATE9_DISPATCHES, followerFills: GATE9_FOLLOWER_FILLS,
    leaderPositions: new Map(), followerPositions: new Map([["BTC", -0.00019]]), followerLeverage: new Map(), rules: {},
    sourceTiming: { coverageThrough: T("2026-10-14T08:55:44.575Z") } });
  assert.deepEqual(r.failures.map((f) => [f.check, f.coin ?? null]), [["signal_expired", null], ["direction_mismatch", "BTC"]]);
});

test("positionBefore: the start of an order's first chunk", () => {
  assert.equal(positionBefore(GATE9_LEADER_FILLS.filter((f) => f.oid === 62677433636)), 0);
  // A flip in two chunks at one time, listed out of order: long 0.5 → short 0.3.
  assert.equal(positionBefore([{ side: "A", sz: "0.3", time: 5, startPosition: "0" }, { side: "A", sz: "0.5", time: 5, startPosition: "0.5" }]), 0.5);
  assert.equal(positionBefore([{ side: "A", sz: "0.3", time: 5 }]), null);
});
