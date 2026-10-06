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
