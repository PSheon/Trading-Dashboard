import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, evaluate, isAllowed, isRiskCap, render } from "./copy-acceptance.mjs";
import { inlineParams, parseArgs, readOnlyScript } from "./ops-db.mjs";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const day = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
let seq = 0;
/** One dispatch row as the statement returns it (settled unless `state` says otherwise). */
function dispatch({ leg, coin, at, state = "settled", reason = null, sign = leg === "open" ? 1 : -1, fill = `fill${++seq}`, adjustmentId = null, id }) {
  const rowId = id ?? `m1|${fill}|${leg}`;
  return { id: rowId, mandate_id: "m1", account_id: "acct1", source_fill_id: fill, leg, coin, state, reason, attempts: 1, adjustment_id: adjustmentId,
    leader_time: at, received_at: at, first_attempt_at: at, sent_at: at, acked_at: at, settled_at: state === "settled" ? at : null, created_at: at, updated_at: at,
    leg_sign: sign, leg_size: "1", leg_fraction: leg === "close" ? "1" : null, leg_state: state === "settled" ? "settled" : state, fill_side: sign === 1 ? "B" : "A", fill_start_position: "0", fill_sz: "1" };
}
function report(dispatches, extra = {}) {
  return {
    queried_at: day(0),
    strategy: { id: 7, user_id: 1, mode: "testnet", network: "mainnet", status: "active", activated_at: day(12), created_at: day(12), stopped_at: null, pause_new_risk: false, reduce_only: false },
    mandates: [{ id: "m1", account_id: "acct1", state: "active", source_network: "mainnet", leader_address: "0x" + "1".repeat(40), created_at: day(12), activation_cursor: day(12), expires_at: day(-20) }],
    dispatches,
    accounts: [{ account_id: "acct1", address: "0x" + "2".repeat(40), account_state: "ready", quarantined: false, reason: null, updated_at: null }],
    quarantined_reservations: [],
    streams: [{ id: "mainnet:0x" + "1".repeat(40), state: "ready", last_issue: null, coverage_through: day(0), updated_at: day(0) }],
    ...extra,
  };
}
/** Every leg type D16 names, inside the first days of the copy. */
function fullHistory() {
  seq = 0;
  const lead = dispatch({ leg: "open", coin: "ETH", at: day(10.5), fill: "lead" });
  lead.adjustment_id = lead.id;
  return [
    dispatch({ leg: "open", coin: "BTC", at: day(11), sign: 1 }),
    dispatch({ leg: "open", coin: "BTC", at: day(10.8), sign: 1 }),                                   // add
    lead, dispatch({ leg: "open", coin: "ETH", at: day(10.5), state: "refused", reason: "merged_into_adjustment", adjustmentId: lead.id }),
    dispatch({ leg: "close", coin: "BTC", at: day(10), sign: -1 }),
    dispatch({ leg: "open", coin: "BTC", at: day(10), sign: -1 }),                                    // flip (same fill as the close)
    dispatch({ leg: "close", coin: "BTC", at: day(9.5), state: "refused", reason: "no_follower_position" }),
    dispatch({ leg: "open", coin: "SOL", at: day(9), state: "refused", reason: "below_min_notional" }),
    dispatch({ leg: "open", coin: "SOL", at: day(8.5), state: "refused", reason: "live_risk_sizing_above_cap" }),
    dispatch({ leg: "open", coin: "SOL", at: day(8.2), state: "refused", reason: "signal_expired" }),
    dispatch({ leg: "open", coin: "SOL", at: day(8.1), state: "refused", reason: "unattempted_expired" }),
  ];
}

test("allowed and risk-cap reasons", () => {
  for (const r of ["no_follower_position", "merged_into_adjustment", "signal_expired", "merged_signal_expired", "price_moved", "live_source_price_deviation",
    "below_min_notional", "below_min_after_rounding", "unattempted_expired", "live_risk_sizing_above_cap", "max_strategy_exposure", "risk_cap_max_order"]) assert.equal(isAllowed(r), true, r);
  for (const r of ["live_settlement_needs_owner", "exchange_order_never_placed", "live_execution_failed", "copy_stopping", "(null)", "flip_close_not_settled"]) assert.equal(isAllowed(r), false, r);
  assert.equal(isRiskCap("live_risk_leverage"), true);
  assert.equal(isRiskCap("below_min_notional"), false);
});

test("PASS: every leg type seen and 7 clean days", () => {
  const r = evaluate(report(fullHistory()), { nowMs: NOW });
  assert.deepEqual(r.legs, { open: 4, add: 1, merged: 1, merged_members: 1, close: 1, flip: 1, min_notional_refusal: 1, risk_cap_refusal: 1 });
  assert.deepEqual(r.missing_legs, []);
  assert.deepEqual(r.not_allowed, []);
  assert.equal(r.streak.start, day(12));
  assert.equal(r.streak.day_of_7, 7);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.verdict, "PASS");
  assert.match(render(r), /\(f\) PASS/);
});

test("FAIL: a refusal outside the list restarts the count at its last occurrence", () => {
  const rows = [...fullHistory(),
    dispatch({ leg: "open", coin: "DOGE", at: day(5), state: "refused", reason: "live_execution_failed", id: "m1|x1|open" }),
    dispatch({ leg: "open", coin: "DOGE", at: day(2.5), state: "refused", reason: "live_execution_failed", id: "m1|x2|open" })];
  const r = evaluate(report(rows), { nowMs: NOW });
  assert.equal(r.verdict, "FAIL");
  const bad = r.not_allowed.find((e) => e.reason === "live_execution_failed");
  assert.equal(bad.count, 2);
  assert.equal(bad.first_id, "m1|x1|open");
  assert.equal(bad.last_id, "m1|x2|open");
  assert.equal(r.streak.start, day(2.5));
  assert.equal(r.streak.day_of_7, 3);
  assert.deepEqual(r.streak.last_reset, { kind: "refusal", what: "live_execution_failed", at: day(2.5), id: "m1|x2|open" });
  assert.ok(r.reasons.some((x) => x.includes("live_execution_failed×2")));
  assert.ok(r.reasons.some((x) => x.startsWith("clean streak is day 3 of 7")));
});

test("FAIL: quarantine and a settlement that went to the owner", () => {
  const rows = [...fullHistory(), dispatch({ leg: "close", coin: "ETH", at: day(1), state: "refused", reason: "live_settlement_needs_owner", id: "m1|q|close" })];
  const r = evaluate(report(rows, {
    accounts: [{ account_id: "acct1", address: "0x" + "2".repeat(40), account_state: "ready", quarantined: true, reason: "live_settlement_needs_owner", updated_at: day(1) }],
    quarantined_reservations: [{ key: "mainnet:0xabc:0xcloid", account_id: "acct1", coin: "ETH", cloid: "0xcloid", state: "quarantined", revision: 2, created_at: day(1.1), updated_at: day(1) }],
  }), { nowMs: NOW });
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.settlement_needs_owner.length, 1);
  assert.equal(r.quarantined_reservations.length, 1);
  assert.equal(r.accounts[0].quarantined, true);
  assert.equal(r.streak.day_of_7, 2);
  assert.ok(r.reasons.some((x) => x.startsWith("account quarantined: acct1")));
  assert.ok(r.reasons.some((x) => x === "1 settlement(s) went to the owner"));
});

test("FAIL: required leg types still missing, --since moves the start", () => {
  const rows = fullHistory().filter((d) => !(d.leg === "open" && d.coin === "BTC" && d.leg_sign === -1) && d.reason !== "live_risk_sizing_above_cap");
  const r = evaluate(report(rows), { nowMs: NOW, sinceMs: Date.parse(day(3)) });
  assert.deepEqual(r.missing_legs, ["flip", "risk_cap_refusal"]);
  assert.equal(r.counted_from, day(3));
  assert.equal(r.streak.day_of_7, 4);
  assert.equal(r.verdict, "FAIL");
});

test("a stopped copy and an unknown copy", () => {
  const r = evaluate(report(fullHistory(), { strategy: { ...report([]).strategy, status: "stopped", stopped_at: day(1) } }), { nowMs: NOW });
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.reasons[0], "copy is stopped, not active");
  assert.throws(() => evaluate({ strategy: null, dispatches: [] }, { nowMs: NOW }), /no copy with that id/);
});

test("the evaluation is deterministic whatever the row order", () => {
  const rows = fullHistory();
  const a = evaluate(report(rows), { nowMs: NOW });
  const b = evaluate(report([...rows].reverse()), { nowMs: NOW });
  assert.deepEqual(a, b);
});

test("--sql-only renders the read-only statement with literal parameters", () => {
  const { text, params } = buildQuery(42, Date.parse("2026-11-01T00:00:00Z"));
  const script = readOnlyScript(text, params);
  assert.ok(script.startsWith("BEGIN READ ONLY;\n"));
  assert.ok(script.endsWith(";\nROLLBACK;\n"));
  assert.ok(!/\$\d/.test(script), "no parameter placeholder left");
  assert.ok(script.includes("WHERE id = 42"));
  assert.ok(script.includes("d.created_at >= '2026-11-01T00:00:00.000Z'::timestamptz"));
  assert.equal(inlineParams("$1 $10 $2", ["a'b", 2, 3, 4, 5, 6, 7, 8, 9, "ten"]), "'a''b' 'ten' 2");
});

test("argument parsing", () => {
  assert.deepEqual(parseArgs(["--strategy", "7", "--json", "--since=2026-11-01T00:00:00Z"], { strategy: "value", json: "flag", since: "value" }),
    { strategy: "7", json: true, since: "2026-11-01T00:00:00Z" });
  assert.throws(() => parseArgs(["--nope"], { strategy: "value" }), /unknown option/);
  assert.throws(() => parseArgs(["--strategy"], { strategy: "value" }), /needs a value/);
});

// Against a migrated scratch database (scripts/test-database.mjs): the
// statement names only columns the schema has. Skipped without TEST_DATABASE_ADMIN_URL.
test("the statement runs against the real schema", { skip: !process.env.TEST_DATABASE_ADMIN_URL && "TEST_DATABASE_ADMIN_URL unset" }, async () => {
  const { withTestDatabase } = await import("../test-database.mjs");
  const { readOnlyQuery } = await import("./ops-db.mjs");
  await withTestDatabase(async (url) => {
    const { text, params } = buildQuery(1, undefined);
    const rows = await readOnlyQuery(url, text, params);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].report.strategy, null);
    assert.deepEqual(rows[0].report.dispatches, []);
    assert.throws(() => evaluate(rows[0].report, { nowMs: NOW }), /no copy with that id/);
  });
});
