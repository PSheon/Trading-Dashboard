import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, HARNESS_LEADER, TERMS, fundingGate, parseEnv, percentile, planCleanup, renderSummary, stopSettled, waitFor } from "./lib.mjs";

test("parseEnv reads KEY=value lines, strips quotes, skips comments", () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="two words"\n  C=\'x=y\'\nlower=no\n\nD=\n'), { A: "1", B: "two words", C: "x=y", D: "" });
});

test("fundingGate: zero balances stop the run with both reasons", () => {
  const gate = fundingGate({ leader: 0, follower: 0 });
  assert.equal(gate.ok, false);
  assert.equal(gate.send, true);
  assert.equal(gate.leaderNeeds, TERMS.sendUsd + TERMS.leaderScenarioUsd);
  assert.equal(gate.problems.length, 2);
  assert.match(gate.problems[0], new RegExp(`${HARNESS_LEADER} holds 0.00 testnet USDC and needs at least 170.00`));
  assert.match(gate.problems[1], /follower's main wallet holds 0.00/);
});

test("fundingGate: a funded follower (a rerun) needs no send, only the scenario's room", () => {
  assert.deepEqual(fundingGate({ leader: 25, follower: 140 }), { ok: true, send: false, leaderNeeds: 20, problems: [] });
  const short = fundingGate({ leader: 5, follower: 140 });
  assert.equal(short.ok, false);
  assert.equal(short.problems.length, 1);
  assert.match(short.problems[0], /for its scenario/);
});

test("fundingGate: a funded leader tops up an empty follower", () => {
  assert.deepEqual(fundingGate({ leader: 300, follower: 0 }), { ok: true, send: true, leaderNeeds: 170, problems: [] });
});

test("percentile is nearest-rank and ignores non-numbers", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([3, 1, 2, NaN], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(percentile([1.234], 1), 1.23);
});

const item = (over) => ({ strategyId: 1, leaderAddress: HARNESS_LEADER, stage: "active", accountId: "acc", mandate: { id: "m1", state: "active", revision: 3 }, setup: null, sweep: null, pendingTransfer: null, ...over });

test("planCleanup stops a running copy of the leader with its mandate revision", () => {
  assert.deepEqual(planCleanup([item({})]), [{ kind: "stop", strategyId: 1, mandateId: "m1", revision: 3, accountId: "acc" }]);
  assert.equal(planCleanup([item({ stage: "paused" })])[0].kind, "stop");
});

test("planCleanup cancels setups waiting for consent or ended, waits for stops and confirmed setups", () => {
  assert.deepEqual(planCleanup([item({ stage: "setup", mandate: null, setup: { id: "s1", stage: "awaiting_consent" } })]), [{ kind: "cancel_setup", strategyId: 1, setupId: "s1" }]);
  assert.equal(planCleanup([item({ stage: "setup", mandate: null, setup: { id: "s1", stage: "failed" } })])[0].kind, "cancel_setup");
  assert.equal(planCleanup([item({ stage: "stopping" })])[0].kind, "await_stop");
  assert.equal(planCleanup([item({ stage: "sweeping" })])[0].kind, "await_stop");
  assert.equal(planCleanup([item({ stage: "funding", mandate: null, setup: { id: "s2", stage: "funding_submitted" } })])[0].kind, "await_setup");
});

test("planCleanup leaves stopped copies and other leaders alone", () => {
  assert.deepEqual(planCleanup([item({ stage: "stopped", mandate: null }), item({ leaderAddress: "0x005a09b498f2a28b54652a70d7812e63414161fe" })]), []);
});

test("stopSettled waits for the stop and its return to finish", () => {
  assert.equal(stopSettled(item({ stage: "stopped", sweep: { amount: "90", status: "credited" } })), true);
  assert.equal(stopSettled(item({ stage: "stopped", sweep: null })), true);
  assert.equal(stopSettled(item({ stage: "stopped", sweep: { amount: "90", status: "accepted" } })), false);
  assert.equal(stopSettled(item({ stage: "stopped", pendingTransfer: { id: "x", direction: "to_main", status: "accepted", amount: "1" } })), false);
  assert.equal(stopSettled(item({ stage: "sweeping" })), false);
  assert.equal(stopSettled(undefined), false);
});

test("renderSummary marks pass, fail and skip, and says ALL GREEN only without failures", () => {
  const green = renderSummary({ checks: [{ name: "a", ok: true, detail: "x" }, { name: "b", ok: null }], latency: { sent: { p50: 1.5, p95: 3, max: 4 } } });
  assert.match(green, /a +PASS +x/);
  assert.match(green, /b +SKIP/);
  assert.match(green, /sent +1\.50 +3\.00 +4\.00/);
  assert.match(green, /ALL GREEN$/);
  const red = renderSummary({ checks: [{ name: "a", ok: false }] });
  assert.match(red, /a +FAIL/);
  assert.match(red, /1 check\(s\) FAILED$/);
});

test("waitFor returns the last value on timeout and stops polling once done", async () => {
  let n = 0;
  assert.deepEqual(await waitFor(async () => ++n, (v) => v >= 3, { timeoutMs: 1000, intervalMs: 1 }), { value: 3, ok: true });
  const late = await waitFor(async () => "no", () => false, { timeoutMs: 20, intervalMs: 5 });
  assert.equal(late.ok, false);
  assert.equal(late.value, "no");
});

test("an unfunded run has its own exit code", () => {
  assert.equal(EXIT.unfunded, 3);
  assert.notEqual(EXIT.unfunded, EXIT.failed);
});

// --- reconciliation rules (checks.mjs) ----------------------------------------------------------
import { DEFAULT_ALLOWED_REFUSALS, evaluate, fixedOrderSize, parseAllowedRefusals } from "./checks.mjs";

/** A clean run: the leader opens and closes ETH; the copy mirrors both at the fixed 12 USD. */
function run(over = {}) {
  const base = {
    leaderFills: [{ oid: 1, tid: 11, coin: "ETH", side: "B", time: 1_000 }, { oid: 2, tid: 12, coin: "ETH", side: "A", time: 2_000 }],
    dispatches: [
      { id: "d1", tid: "11", leg: "open", coin: "ETH", state: "settled", reason: "", adjustmentId: "", executionState: "filled", cloid: "0xc1", orderSize: "0.004", limitPx: "3000" },
      { id: "d2", tid: "12", leg: "close", coin: "ETH", state: "settled", reason: "", adjustmentId: "", executionState: "filled", cloid: "0xc2", orderSize: "0.004", limitPx: "2990" },
    ],
    followerFills: [{ cloid: "0xc1", oid: 91, coin: "ETH", side: "B", sz: "0.004", px: "2995" }, { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.004", px: "2994" }],
    leaderPositions: new Map([["ETH", 0]]), followerPositions: new Map([["ETH", 0]]),
    followerLeverage: new Map([["ETH", 3]]), szDecimals: new Map([["ETH", 4], ["BTC", 5]]),
    rules: { allowedRefusals: DEFAULT_ALLOWED_REFUSALS, sizing: { perTradeUsd: 12, maxPerTradeUsd: 15, minOrderUsd: 10 }, maxLeverage: 3 },
  };
  return evaluate({ ...base, ...over, rules: { ...base.rules, ...over.rules } }).failures.map((f) => f.check);
}
const dispatch = (i, patch) => { const d = structuredClone([
  { id: "d1", tid: "11", leg: "open", coin: "ETH", state: "settled", reason: "", adjustmentId: "", executionState: "filled", cloid: "0xc1", orderSize: "0.004", limitPx: "3000" },
  { id: "d2", tid: "12", leg: "close", coin: "ETH", state: "settled", reason: "", adjustmentId: "", executionState: "filled", cloid: "0xc2", orderSize: "0.004", limitPx: "2990" }]); d[i] = { ...d[i], ...patch }; return d; };

test("reconcile: a clean mirrored run has no failures", () => {
  assert.deepEqual(run(), []);
});

test("reconcile FAILS when an expected leader leg has no follower fill (an open sent but never filled)", () => {
  const dispatches = dispatch(0, { state: "submitted", executionState: "unknown" });
  dispatches[1] = { ...dispatches[1], state: "refused", reason: "no_follower_position", executionState: "", cloid: "" };
  assert.deepEqual(run({ dispatches, followerFills: [] }), ["leader_leg_without_follower_fill"]);
  // Still pending at the end of the run: the same.
  assert.deepEqual(run({ dispatches: [{ ...dispatches[0], state: "pending", cloid: "", executionState: "" }, dispatches[1]], followerFills: [] }), ["leader_leg_without_follower_fill"]);
});

test("reconcile FAILS on a refusal outside the allowlist, and accepts an allowed one (optionally per coin)", () => {
  const refused = (reason) => [{ ...dispatch(0, {})[0], state: "refused", reason, executionState: "", cloid: "" }, { ...dispatch(1, {})[1], state: "refused", reason: "no_follower_position", executionState: "", cloid: "" }];
  assert.deepEqual(run({ dispatches: refused("live_risk_leverage"), followerFills: [] }), ["refusal_not_allowed"]);
  assert.deepEqual(run({ dispatches: refused("live_market_hip3_unsupported"), followerFills: [] }), []);
  assert.deepEqual(run({ dispatches: refused("below_min_notional"), followerFills: [] }), ["refusal_not_allowed"]);
  assert.deepEqual(run({ dispatches: refused("below_min_notional"), followerFills: [], rules: { allowedRefusals: [...DEFAULT_ALLOWED_REFUSALS, ...parseAllowedRefusals(["below_min_notional:ETH"])] } }), []);
  assert.deepEqual(run({ dispatches: refused("below_min_notional"), followerFills: [], rules: { allowedRefusals: [...DEFAULT_ALLOWED_REFUSALS, ...parseAllowedRefusals(["below_min_notional:SOL"])] } }), ["refusal_not_allowed"]);
  // A merged leg is checked through its lead (which filled).
  const merged = [...dispatch(0, {}).slice(0, 1), { ...dispatch(0, {})[0], id: "d3", tid: "13", state: "refused", reason: "merged_into_adjustment", adjustmentId: "d1", cloid: "" }, dispatch(1, {})[1]];
  assert.deepEqual(run({ dispatches: merged, leaderFills: [{ oid: 1, tid: 11, coin: "ETH", side: "B", time: 1_000 }, { oid: 3, tid: 13, coin: "ETH", side: "B", time: 1_500 }, { oid: 2, tid: 12, coin: "ETH", side: "A", time: 2_000 }] }), []);
});

test("reconcile FAILS when the follower's fill doesn't match fixed sizing (per-trade USD / limit price at szDecimals)", () => {
  const fills = [{ cloid: "0xc1", oid: 91, coin: "ETH", side: "B", sz: "0.008", px: "2995" }, { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.008", px: "2994" }];
  assert.deepEqual(run({ followerFills: fills }), ["fixed_size_mismatch"]);
  // One lot of rounding is fine; the exchange-minimum round-up (10 USD) too.
  assert.deepEqual(run({ followerFills: [{ ...fills[0], sz: "0.0041" }, { ...fills[1], sz: "0.0041" }] }), []);
  assert.equal(fixedOrderSize({ perTradeUsd: 12, maxPerTradeUsd: 15, minOrderUsd: 10 }, 3000, 4), "0.004");
  assert.equal(fixedOrderSize({ perTradeUsd: 12, maxPerTradeUsd: 15, minOrderUsd: 10 }, 9, 0), null); // 1 lot = 9 USD, 2 lots = 18 > 15: refused
  assert.equal(fixedOrderSize({ perTradeUsd: 12, maxPerTradeUsd: 15, minOrderUsd: 10 }, 7, 0), "2"); // 1 lot = 7 USD < 10: rounded up to 14
  // Without sizing terms the check is skipped.
  assert.deepEqual(run({ followerFills: fills, rules: { sizing: null } }), []);
});

test("reconcile FAILS when the follower's leverage on a coin is above the cap", () => {
  assert.deepEqual(run({ followerLeverage: new Map([["ETH", 10]]) }), ["follower_leverage_above_cap"]);
  assert.deepEqual(run({ followerLeverage: new Map([["ETH", 10]]), rules: { maxLeverage: null } }), []);
});

test("reconcile FAILS when the leader ended flat and the follower still holds a position (any coin)", () => {
  assert.deepEqual(run({ followerPositions: new Map([["ETH", 0], ["BTC", 0.001]]) }), ["follower_not_flat"]);
});

function minimumReduction(over = {}) {
  return run({
    leaderFills: [{ oid: 1, tid: 11, coin: "ETH", side: "B", time: 1000 },
      { oid: 2, tid: 12, coin: "ETH", side: "A", time: 2000, startPosition: "0.008", sz: "0.004" }],
    leaderPositions: new Map([["ETH", 0.004]]),
    dispatches: dispatch(1, { reduceOnly: true }),
    followerFills: [{ cloid: "0xc1", oid: 91, coin: "ETH", side: "B", sz: "0.004", px: "2995", time: 1500 },
      { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.004", startPosition: "0.004", px: "2994", time: 2500 }],
    ...over,
  });
}

test("reconcile accepts a proven minimum-size reduction closing the entire follower while the leader stays long", () => {
  assert.deepEqual(minimumReduction(), []);
});

test("reconcile keeps a flat-follower mismatch without reduce-only full-close evidence", () => {
  assert.ok(minimumReduction({ dispatches: dispatch(1, {}) }).includes("direction_mismatch"));
  assert.ok(minimumReduction({ followerFills: [] }).includes("direction_mismatch"));
  assert.ok(minimumReduction({ dispatches: dispatch(1, { reduceOnly: true, state: "submitted" }) }).includes("direction_mismatch"));
});

test("reconcile does not accept a minimum-close exception for an opposite position or an ordinary leader open", () => {
  assert.ok(minimumReduction({ followerPositions: new Map([["ETH", -0.004]]) }).includes("direction_mismatch"));
  assert.ok(minimumReduction({ leaderPositions: new Map([["ETH", -0.004]]) }).includes("direction_mismatch"));
  assert.ok(minimumReduction({ leaderPositions: new Map([["ETH", -1e-13]]), leaderFills: [
    { oid: 1, tid: 11, coin: "ETH", side: "B", time: 1000 },
    { oid: 2, tid: 12, coin: "ETH", side: "A", time: 2000, startPosition: "0.0000000000002", sz: "0.0000000000001" },
  ] }).includes("direction_mismatch"));
  assert.ok(minimumReduction({ leaderPositions: new Map([["ETH", 0.008]]) }).includes("direction_mismatch"));
  assert.ok(minimumReduction({ leaderFills: [{ oid: 2, tid: 12, coin: "ETH", side: "B", time: 2000, startPosition: "0.004", sz: "0.004" }] }).includes("direction_mismatch"));
});

test("reconcile requires a small reduction and a small remainder, plus original full-close metadata", () => {
  const close = { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.004", startPosition: "0.004", px: "2994", time: 2500 };
  const open = { cloid: "0xc1", oid: 91, coin: "ETH", side: "B", sz: "0.004", px: "2995", time: 1500 };
  for (const patch of [{ startPosition: undefined }, { startPosition: "0.005" }, { time: undefined }, { px: "6000" }, { px: "NaN" }]) {
    assert.ok(minimumReduction({ followerFills: [open, { ...close, ...patch }] }).includes("direction_mismatch"));
  }
});

test("reconcile cannot raise the planner's fixed 10 USD close minimum through CLI sizing terms", () => {
  assert.ok(minimumReduction({
    followerFills: [{ cloid: "0xc1", oid: 91, coin: "ETH", side: "B", sz: "0.004", px: "2995", time: 1500 },
      { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.004", startPosition: "0.004", px: "6000", time: 2500 }],
    rules: { sizing: { perTradeUsd: 12, maxPerTradeUsd: 15, minOrderUsd: 20 } },
  }).includes("direction_mismatch"));
});

test("reconcile refuses ambiguous latest source fills at the same millisecond", () => {
  assert.ok(minimumReduction({ leaderFills: [
    { oid: 1, tid: 11, coin: "ETH", side: "B", time: 1000 },
    { oid: 2, tid: 12, coin: "ETH", side: "A", time: 2000, startPosition: "0.008", sz: "0.004" },
    { oid: 3, tid: 13, coin: "ETH", side: "B", time: 2000, startPosition: "0.004", sz: "0.004" },
  ] }).includes("direction_mismatch"));
});

test("reconcile does not round an exactly 10 USD proportional reduction below the minimum", () => {
  assert.ok(minimumReduction({
    leaderPositions: new Map([["ETH", 0.001]]),
    leaderFills: [{ oid: 1, tid: 11, coin: "ETH", side: "B", time: 1000 },
      { oid: 2, tid: 12, coin: "ETH", side: "A", time: 2000, startPosition: "0.003", sz: "0.002" }],
    dispatches: dispatch(1, { reduceOnly: true, limitPx: "1000" }),
    followerFills: [{ cloid: "0xc1", oid: 91, coin: "ETH", side: "B", sz: "0.004", px: "2995", time: 1500 },
      { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.015", startPosition: "0.015", px: "1000", time: 2500 }],
  }).includes("direction_mismatch"));
});

test("reconcile cannot use the last chunk of a multi-fill close as the original held position", () => {
  assert.ok(minimumReduction({ followerFills: [
    { cloid: "0xc1", oid: 91, coin: "ETH", side: "B", sz: "0.004", px: "2995", time: 1500 },
    { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.004", startPosition: "0.008", px: "2994", time: 2400 },
    { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.004", startPosition: "0.004", px: "2994", time: 2500 },
  ] }).includes("direction_mismatch"));
});

test("reconcile proves same-order leader reduction chunks by their contiguous original positions", () => {
  const fills = [
    { oid: 1, tid: 11, coin: "ETH", side: "B", time: 1000 },
    { oid: 2, tid: 12, coin: "ETH", side: "A", time: 2000, startPosition: "0.008", sz: "0.002" },
    { oid: 2, tid: 13, coin: "ETH", side: "A", time: 2000, startPosition: "0.006", sz: "0.002" },
  ];
  const dispatches = [...dispatch(1, { reduceOnly: true }),
    { id: 'd3', tid: '13', coin: 'ETH', leg: 'close', state: 'refused', reason: 'no_follower_position', cloid: '' }];
  assert.deepEqual(minimumReduction({ leaderFills: fills, dispatches }), []);
  assert.deepEqual(minimumReduction({ leaderFills: [fills[0], fills[2], fills[1]], dispatches }), []);
  assert.ok(minimumReduction({ leaderFills: fills, dispatches: dispatches.slice(0, 2) }).includes('direction_mismatch'));
  assert.ok(minimumReduction({ leaderFills: [fills[0], fills[1], { ...fills[2], startPosition: '0.007' }], dispatches }).includes('direction_mismatch'));
  assert.ok(minimumReduction({ leaderFills: [fills[0], fills[1], { ...fills[2], time: 1900 }], dispatches }).includes('direction_mismatch'));
  assert.ok(minimumReduction({ leaderFills: fills, dispatches, leaderPositions: new Map([['ETH', NaN]]) }).includes('direction_mismatch'));
});

test("reconcile accepts the same proven minimum reduction for a short position", () => {
  assert.deepEqual(minimumReduction({
    leaderPositions: new Map([["ETH", -0.004]]),
    leaderFills: [{ oid: 1, tid: 11, coin: "ETH", side: "A", time: 1000 },
      { oid: 2, tid: 12, coin: "ETH", side: "B", time: 2000, startPosition: "-0.008", sz: "0.004" }],
    followerFills: [{ cloid: "0xc1", oid: 91, coin: "ETH", side: "A", sz: "0.004", px: "2995", time: 1500 },
      { cloid: "0xc2", oid: 92, coin: "ETH", side: "B", sz: "0.004", startPosition: "-0.004", px: "2994", time: 2500 }],
  }), []);
});

test("reconcile FAILS on a follower order no leg sent (a double send), but not on a stop's or owner's close", () => {
  const extra = { cloid: "0xc9", oid: 99, coin: "ETH", side: "B", sz: "0.004", px: "2995" };
  const fills = [...[{ cloid: "0xc1", oid: 91, coin: "ETH", side: "B", sz: "0.004", px: "2995" }, { cloid: "0xc2", oid: 92, coin: "ETH", side: "A", sz: "0.004", px: "2994" }], extra];
  assert.deepEqual(run({ followerFills: fills }), ["follower_order_without_dispatch"]);
  assert.deepEqual(run({ followerFills: fills, closeCloids: new Set(["0xc9"]) }), []);
  assert.deepEqual(run({ followerFills: fills, dispatches: null }), []);
});

import { SCENARIOS, parseScenarios, refusableCoin, termsFor } from "./lib.mjs";
import * as harnessLib from './lib.mjs';

test('scenario 8 has an explicit empty selection within Stage caps instead of crashing', () => {
  const terms = { perTradeUsd: 12, maxPerTradeUsd: 15, minOrderUsd: 10 };
  assert.equal(harnessLib.refusableMarket([{ name: 'ETH', szDecimals: 4, mid: 3000 }], terms, fixedOrderSize), null);
  const selected = harnessLib.refusableMarket([{ name: 'LOT9', szDecimals: 0, mid: 9 }], terms, fixedOrderSize);
  assert.deepEqual(selected, { coin: 'LOT9', szDecimals: 0, mid: 9, lotUsd: 9, terms });
});
test("scenarios: by name or number, deduplicated, base by default; unknown ones refused", () => {
  assert.deepEqual(parseScenarios(undefined), ["base"]);
  assert.deepEqual(parseScenarios("3,stop-open,6,7,8,9,14,3"), ["reduce-min", "stop-open", "close-then-stop", "worker-restart", "refused-open", "burst", "kill-switch"]);
  assert.throws(() => parseScenarios("5"), /unknown scenario 5/);
  assert.equal(Object.values(SCENARIOS).filter((s) => s.endsCopy).length, 4);
});
test("profiles: stage-caps mirrors Stage (12–15 per trade, 50 per copy, leverage 3)", () => {
  assert.deepEqual(termsFor("stage-caps"), { ...TERMS, budgetUsd: 50, maxPerTradeUsd: 15, maxLeverage: 3, profile: "stage-caps" });
  assert.equal(termsFor().budgetUsd, TERMS.budgetUsd);
  assert.throws(() => termsFor("mainnet"), /unknown profile/);
});
test("refusableCoin picks a coin whose fixed amount falls under the minimum and can't be rounded up within the cap", () => {
  const terms = { perTradeUsd: 12, maxPerTradeUsd: 15, minOrderUsd: 10 };
  const markets = [{ name: "ETH", szDecimals: 4, mid: 2600 }, { name: "CHEAP", szDecimals: 0, mid: 7 }, { name: "LOT9", szDecimals: 0, mid: 8.8 }, { name: "BIG", szDecimals: 0, mid: 40 },
    { name: "GONE", szDecimals: 0, mid: 9, delisted: true }, { name: "xyz:LOT9", szDecimals: 0, mid: 8.8 }];
  assert.equal(refusableCoin(markets, terms, fixedOrderSize)?.name, "LOT9");
  assert.equal(refusableCoin([markets[0], markets[1]], terms, fixedOrderSize), null);
  assert.equal(refusableCoin([markets[3]], terms, fixedOrderSize)?.name, "BIG");
});

// Browser/network boundaries are mocked so these tests never launch Chrome
// or sign anything. The harness must preserve the shared browser session.
import { mock } from 'node:test';
import { createRequire } from 'node:module';
import { launch, confirmFromPortfolio } from './follower.mjs';

function confirmationPage(alerts, completeAt) {
  const responses = [];
  let ticks = 0, clicks = 0;
  const action = { waitFor: async () => {}, isVisible: async () => true, click: async () => { clicks++; } };
  const confirm = {
    getByTestId: () => ({ waitFor: async () => {}, innerText: async () => 'testnet · 50 USDC' }),
    getByRole: role => role === 'alert' ? { count: async () => alerts[ticks - 1] ? 1 : 0, innerText: async () => alerts[ticks - 1] } : action,
  };
  const cards = { first: () => action, count: async () => 1, nth: () => action, filter() { return this; } };
  const page = {
    on: (event, handler) => { if (event === 'response') responses.push(handler); }, off: () => {},
    route: async () => {}, unroute: async () => {}, goto: async () => {},
    getByTestId: name => name === 'live-copy-card' ? cards : { waitFor: async () => {}, getByRole: () => action },
    getByRole: () => confirm,
    waitForTimeout: async () => {
      ticks++;
      if (ticks === completeAt) for (const handler of responses) await handler({
        url: () => 'http://localhost:3100/me/copy/live/setups/test-setup/confirm', status: () => 200,
        json: async () => ({ data: { stage: 'funding_submitted' } }),
      });
    },
  };
  return { page, ticks: () => ticks, clicks: () => clicks };
}

test('confirmation waits for the response without repeating the confirm action', async () => {
  const browser = confirmationPage([], 3);
  const result = await confirmFromPortfolio(browser.page, { web: 'http://localhost:3000', setupId: 'test-setup' });
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.confirmStatus, 200);
  assert.equal(browser.ticks(), 3);
  // Card, resume and confirm each once; never a second signing/deposit click.
  assert.equal(browser.clicks(), 3);
});

test('confirmation still fails immediately for a terminal signing alert', async () => {
  const browser = confirmationPage(['已取消簽署。'], 3);
  const result = await confirmFromPortfolio(browser.page, { web: 'http://localhost:3000', setupId: 'test-setup' });
  assert.equal(result.outcome, 'alert');
  assert.equal(result.alert, '已取消簽署。');
  assert.equal(browser.ticks(), 1);
});

test('confirmation does not conceal a wallet readiness error as successful waiting', async () => {
  const browser = confirmationPage(['錢包仍在載入，準備好後設定會自動繼續。'], 3);
  const result = await confirmFromPortfolio(browser.page, { web: 'http://localhost:3000', setupId: 'test-setup' });
  assert.equal(result.outcome, 'alert');
  assert.equal(result.confirmStatus, null);
  assert.equal(browser.ticks(), 1);
});
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
test('a supplied CDP endpoint attaches to the shared browser without starting another Chrome', async () => {
  const { chromium } = webRequire('@playwright/test');
  const shared = { shared: true }, fresh = { shared: false };
  let spawned = 0;
  const launchMock = mock.method(chromium, 'launch', async () => { spawned++; return fresh; });
  const connectMock = mock.method(chromium, 'connectOverCDP', async endpoint => {
    assert.equal(endpoint, 'http://127.0.0.1:9333');
    return shared;
  });
  try {
    const browser = await launch({ cdpEndpoint: 'http://127.0.0.1:9333' });
    assert.equal(spawned, 0, 'a second browser would lose the shared session and exceed the resource limit');
    assert.equal(browser, shared);
  } finally { launchMock.mock.restore(); connectMock.mock.restore(); }
});
test('portfolio confirmation opens the actual deployment view instead of waiting for a live copy in paper mode', async () => {
  const stop = new Error('stop before any confirmation');
  let selected = 'paper';
  const cards = { filter() { return this; }, first() { return this; }, async waitFor() { throw stop; } };
  const page = { on() {}, async route() {}, async goto(url) {
    selected = new URL(url).searchParams.get('view') === 'real' ? 'actual' : 'paper';
  }, getByTestId() { return cards; } };
  await assert.rejects(confirmFromPortfolio(page, { web: 'http://localhost:3000', setupId: 'test-setup' }), e => e === stop);
  assert.equal(selected, 'actual', 'the global mode otherwise hides the pending actual copy');
});
