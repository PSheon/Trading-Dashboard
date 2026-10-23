#!/usr/bin/env node
/**
 * The D16 acceptance verdict for one live copy (docs/decisions-2026-10-23.md):
 * every leg type seen at least once (flip and a risk-cap refusal are the two
 * still owed), and seven consecutive days in which every refusal reason is on
 * the expected list, the copy's account was never quarantined and no
 * settlement went to its owner. Read-only: one statement in a
 * `BEGIN READ ONLY` transaction, rolled back.
 *
 *   DATABASE_URL=… node scripts/ops/copy-acceptance.mjs --strategy <id> [--since <iso>] [--now <iso>] [--json]
 *   node scripts/ops/copy-acceptance.mjs --strategy <id> [--since <iso>] --sql-only   # the query, for psql
 *   node scripts/ops/copy-acceptance.mjs --strategy <id> --input report.json [--json]  # the verdict from psql's JSON
 *
 * --strategy  the copy_strategies.id of the live copy.
 * --since     count from this time instead of the copy's activation (D18: the
 *             restart after the key rotation is day 1).
 * --now       the clock to judge by (tests); default: now.
 * --sql-only  print the read-only statement instead of running it. Pipe it
 *             into a psql that reaches the database with `-At` and save the
 *             one JSON line it prints; `--input` turns that into the verdict.
 * --json      machine-readable report instead of text.
 *
 * Exit 0 on PASS, 1 on FAIL, 2 on an error (unknown copy, no database, bad arguments).
 *
 * Sources: copy_live_dispatches (one row per planned leg: state, reason,
 * adjustment_id for merged legs), copy_live_signal_legs (the leg's sign),
 * copy_live_source_fills (the leader fill), copy_follower_account_state and
 * copy_live_risk_reservations (quarantine; a settlement whose retries ran out
 * quarantines its reservation and leaves `live_settlement_needs_owner` on the
 * dispatch: copy-live-engine.ts settlementToOwner, the ALERT is only logged).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describeError, loadReport, parseArgs, parseTime, readOnlyScript } from "./ops-db.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUIRED_DAYS = 7;

/** The dispatch reason a settlement leaves once its retries are over (live-worker/settlement-retries.ts). */
export const SETTLEMENT_NEEDS_OWNER = "live_settlement_needs_owner";

/** Refusals a risk cap produces: the live risk authority's caps
 * (postgres-live-risk-authority.ts), the exposure caps and the leverage cap
 * (live-account-risk.ts, copy-live-engine.ts PERMANENT), and the paper
 * engine's `risk_cap_*` family (copy-order-reason.ts). */
const RISK_CAP_REASONS = new Set([
  "live_risk_sizing_above_cap", "live_risk_budget_above_cap", "live_risk_leverage_above_cap", "live_risk_strategy_cap",
  "live_risk_leverage", "live_risk_leverage_margin", "max_strategy_exposure", "max_user_exposure", "max_coin_exposure",
]);
export function isRiskCap(reason) {
  return typeof reason === "string" && (RISK_CAP_REASONS.has(reason) || reason.startsWith("risk_cap_"));
}
/** Below the exchange minimum, before or after rounding. */
export function isMinNotional(reason) {
  return typeof reason === "string" && reason.startsWith("below_min_");
}
/** D16's expected refusals: nothing to close, merged into an adjustment, an
 * aged signal, a price that moved, below the minimum, a risk cap; plus a
 * reservation that expired before any attempt (never sent). */
const ALLOWED_REASONS = new Set([
  "no_follower_position", "merged_into_adjustment", "signal_expired", "merged_signal_expired",
  "price_moved", "live_source_price_deviation", "unattempted_expired",
]);
export function isAllowed(reason) {
  return ALLOWED_REASONS.has(reason) || isMinNotional(reason) || isRiskCap(reason);
}

/** One statement, one JSON object: everything the verdict reads about the copy. */
export function buildQuery(strategyId, sinceMs) {
  const text = `WITH s AS (SELECT * FROM copy_strategies WHERE id = $1),
m AS (SELECT * FROM copy_live_mandates WHERE strategy_id = $1),
d AS (
  SELECT d.id, d.mandate_id, d.account_id, d.source_fill_id, d.leg, d.coin, d.state, d.reason, d.attempts, d.adjustment_id,
         d.leader_time, d.received_at, d.first_attempt_at, d.sent_at, d.acked_at, d.settled_at, d.created_at, d.updated_at,
         l.sign AS leg_sign, l.size AS leg_size, l.fraction AS leg_fraction, l.state AS leg_state,
         f.side AS fill_side, f.start_position AS fill_start_position, f.sz AS fill_sz
  FROM copy_live_dispatches d
  LEFT JOIN copy_live_signal_legs l ON l.mandate_id = d.mandate_id AND l.source_fill_id = d.source_fill_id AND l.leg = d.leg
  LEFT JOIN copy_live_source_fills f ON f.id = d.source_fill_id
  WHERE d.strategy_id = $1 AND d.created_at >= $2::timestamptz)
SELECT json_build_object(
  'queried_at', now(),
  'strategy', (SELECT row_to_json(x) FROM (SELECT id, user_id, mode, network, status, activated_at, created_at, stopped_at, pause_new_risk, reduce_only FROM s) x),
  'mandates', (SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.created_at, x.id), '[]'::json)
               FROM (SELECT id, account_id, state, source_network, leader_address, created_at, activation_cursor, expires_at FROM m) x),
  'dispatches', (SELECT coalesce(json_agg(row_to_json(d) ORDER BY d.leader_time, d.id), '[]'::json) FROM d),
  'accounts', (SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.account_id), '[]'::json)
               FROM (SELECT a.id AS account_id, a.address, a.state AS account_state, coalesce(st.quarantined, false) AS quarantined, st.reason, st.updated_at
                     FROM copy_execution_accounts a LEFT JOIN copy_follower_account_state st ON st.account_id = a.id WHERE a.strategy_id = $1) x),
  'quarantined_reservations', (SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.updated_at, x.key), '[]'::json)
               FROM (SELECT key, account_id, coin, cloid, state, revision, created_at, updated_at FROM copy_live_risk_reservations WHERE strategy_id = $1 AND state = 'quarantined') x),
  'streams', (SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.id), '[]'::json)
              FROM (SELECT st.id, st.state, st.last_issue, st.coverage_through, st.updated_at FROM copy_live_source_streams st
                    WHERE (st.network, st.leader_address) IN (SELECT source_network, leader_address FROM m)) x)
) AS report`;
  return { text, params: [strategyId, new Date(sinceMs ?? 0)] };
}

const ms = (value) => (value === null || value === undefined ? null : Date.parse(value));
const iso = (value) => (value === null || value === undefined || !Number.isFinite(value) ? null : new Date(value).toISOString());
/** The leg's direction: the planner's sign, else the leader fill's side (B = long). */
function signOf(row) {
  if (row.leg_sign === 1 || row.leg_sign === -1) return row.leg_sign;
  return row.fill_side === "B" ? 1 : row.fill_side === "A" ? -1 : null;
}

/**
 * The verdict from the statement's JSON. Deterministic: `nowMs` is the clock,
 * `sinceMs` (optional) the start of the count instead of the activation.
 */
export function evaluate(report, { nowMs, sinceMs } = {}) {
  const now = nowMs ?? Date.now();
  const strategy = report.strategy;
  if (!strategy) throw new Error("no copy with that id");
  const dispatches = [...report.dispatches].sort((a, b) => (ms(a.leader_time) - ms(b.leader_time)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const startMs = sinceMs ?? ms(strategy.activated_at);

  // (a) legs seen per type.
  const legs = { open: 0, add: 0, merged: 0, merged_members: 0, close: 0, flip: 0, min_notional_refusal: 0, risk_cap_refusal: 0 };
  const lastOpenSign = new Map(), lastSettledLeg = new Map();
  for (const row of dispatches) {
    if (row.state === "settled" && row.leg === "open") {
      legs.open++;
      const sign = signOf(row), previous = lastOpenSign.get(row.coin);
      if (previous !== undefined && sign !== null && sign !== previous) legs.flip++;
      else if (previous !== undefined && lastSettledLeg.get(row.coin) === "open") legs.add++;
      if (row.adjustment_id === row.id) legs.merged++;
      if (sign !== null) lastOpenSign.set(row.coin, sign);
      lastSettledLeg.set(row.coin, "open");
    } else if (row.state === "settled" && row.leg === "close") {
      legs.close++;
      lastSettledLeg.set(row.coin, "close");
    } else if (row.state === "refused") {
      if (row.reason === "merged_into_adjustment") legs.merged_members++;
      if (isMinNotional(row.reason)) legs.min_notional_refusal++;
      if (isRiskCap(row.reason)) legs.risk_cap_refusal++;
    }
  }
  const required = { open: legs.open > 0, close: legs.close > 0, flip: legs.flip > 0, risk_cap_refusal: legs.risk_cap_refusal > 0 };
  const missingLegs = Object.keys(required).filter((k) => !required[k]);

  // (b) refusal reasons, allowed and not.
  const byReason = new Map();
  for (const row of dispatches) {
    if (row.state !== "refused") continue;
    const reason = row.reason ?? "(null)", at = ms(row.updated_at);
    const entry = byReason.get(reason) ?? { reason, allowed: isAllowed(reason), count: 0, first_at: null, first_id: null, last_at: null, last_id: null };
    entry.count++;
    if (entry.first_at === null || at < entry.first_at) { entry.first_at = at; entry.first_id = row.id; }
    if (entry.last_at === null || at > entry.last_at) { entry.last_at = at; entry.last_id = row.id; }
    byReason.set(reason, entry);
  }
  const refusals = [...byReason.values()].sort((a, b) => a.reason.localeCompare(b.reason))
    .map((e) => ({ ...e, first_at: iso(e.first_at), last_at: iso(e.last_at) }));
  const notAllowed = refusals.filter((e) => !e.allowed);
  // Legs still pending or submitted keep their last failure in `reason`: not refusals, but worth seeing.
  const openWork = new Map();
  for (const row of dispatches) {
    if (row.state === "settled" || row.state === "refused") continue;
    const key = `${row.state}:${row.reason ?? "(none)"}`;
    openWork.set(key, (openWork.get(key) ?? 0) + 1);
  }
  const unsettled = [...openWork].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ state: key.split(":")[0], reason: key.slice(key.indexOf(":") + 1), count }));

  // (c) quarantine.
  const accounts = report.accounts.map((a) => ({ account_id: a.account_id, address: a.address, account_state: a.account_state, quarantined: a.quarantined === true, reason: a.reason ?? null, updated_at: a.updated_at ?? null }));
  const quarantinedAccounts = accounts.filter((a) => a.quarantined);
  const quarantinedReservations = report.quarantined_reservations.map((r) => ({ key: r.key, account_id: r.account_id, coin: r.coin, updated_at: r.updated_at }));

  // (d) settlements that went to the owner.
  const needsOwner = dispatches.filter((row) => row.reason === SETTLEMENT_NEEDS_OWNER)
    .map((row) => ({ dispatch_id: row.id, state: row.state, coin: row.coin, at: row.updated_at }));

  // (e) the clean streak: from the copy's start, or the latest event that resets it.
  const resets = [];
  for (const e of notAllowed) resets.push({ kind: "refusal", what: e.reason, at: ms(e.last_at), id: e.last_id });
  for (const a of quarantinedAccounts) resets.push({ kind: "quarantine", what: a.reason, at: ms(a.updated_at) ?? now, id: a.account_id });
  for (const r of quarantinedReservations) resets.push({ kind: "reservation_quarantined", what: r.coin, at: ms(r.updated_at), id: r.key });
  for (const n of needsOwner) resets.push({ kind: "settlement_needs_owner", what: n.coin, at: ms(n.at), id: n.dispatch_id });
  resets.sort((a, b) => (b.at - a.at) || a.id.localeCompare(b.id));
  const lastReset = resets[0] ?? null;
  const streakStart = Math.max(startMs, lastReset?.at ?? -Infinity);
  const cleanDays = Math.max(0, (now - streakStart) / DAY_MS);
  const dayOf7 = Math.min(REQUIRED_DAYS, Math.floor(cleanDays) + 1);

  // (f) the verdict.
  const reasons = [];
  if (strategy.status !== "active") reasons.push(`copy is ${strategy.status}, not active`);
  if (missingLegs.length) reasons.push(`leg types not seen yet: ${missingLegs.join(", ")}`);
  if (quarantinedAccounts.length) reasons.push(`account quarantined: ${quarantinedAccounts.map((a) => `${a.account_id} (${a.reason})`).join(", ")}`);
  if (quarantinedReservations.length) reasons.push(`${quarantinedReservations.length} reservation(s) quarantined`);
  if (needsOwner.length) reasons.push(`${needsOwner.length} settlement(s) went to the owner`);
  if (notAllowed.length) reasons.push(`refusal reasons outside the expected list: ${notAllowed.map((e) => `${e.reason}×${e.count}`).join(", ")}`);
  if (cleanDays < REQUIRED_DAYS) reasons.push(`clean streak is day ${dayOf7} of ${REQUIRED_DAYS} (${cleanDays.toFixed(2)} days since ${iso(streakStart)})`);
  const verdict = reasons.length ? "FAIL" : "PASS";

  return {
    verdict, reasons, now: iso(now), queried_at: report.queried_at ?? null,
    strategy: { id: strategy.id, status: strategy.status, mode: strategy.mode, network: strategy.network, activated_at: strategy.activated_at, stopped_at: strategy.stopped_at ?? null,
      pause_new_risk: strategy.pause_new_risk, reduce_only: strategy.reduce_only },
    counted_from: iso(startMs), dispatches: dispatches.length,
    legs, missing_legs: missingLegs, refusals, not_allowed: notAllowed, unsettled,
    accounts, quarantined_reservations: quarantinedReservations, streams: report.streams ?? [], settlement_needs_owner: needsOwner,
    streak: { start: iso(streakStart), clean_days: Number(cleanDays.toFixed(3)), day_of_7: dayOf7, required_days: REQUIRED_DAYS,
      last_reset: lastReset ? { ...lastReset, at: iso(lastReset.at) } : null },
  };
}

export function render(r) {
  const lines = [];
  lines.push(`copy ${r.strategy.id} (${r.strategy.mode}/${r.strategy.network}, ${r.strategy.status}) activated ${r.strategy.activated_at}; counted from ${r.counted_from}; now ${r.now}`);
  lines.push(`dispatches: ${r.dispatches}`);
  lines.push("(a) legs seen: " + Object.entries(r.legs).map(([k, v]) => `${k}=${v}`).join("  "));
  lines.push(`    required still missing: ${r.missing_legs.length ? r.missing_legs.join(", ") : "none"}`);
  lines.push("(b) refusal reasons:");
  if (!r.refusals.length) lines.push("    none");
  for (const e of r.refusals) lines.push(`    ${e.allowed ? "allowed    " : "NOT ALLOWED"} ${e.reason} ×${e.count}  first ${e.first_at} ${e.first_id}  last ${e.last_at} ${e.last_id}`);
  if (r.unsettled.length) lines.push("    unsettled legs (state:last reason): " + r.unsettled.map((u) => `${u.state}:${u.reason}×${u.count}`).join("  "));
  lines.push("(c) accounts:");
  for (const a of r.accounts) lines.push(`    ${a.account_id} ${a.account_state} quarantined=${a.quarantined}${a.quarantined ? ` (${a.reason}, ${a.updated_at})` : ""}`);
  lines.push(`    reservations quarantined: ${r.quarantined_reservations.length}` + r.quarantined_reservations.map((q) => `\n      ${q.key} ${q.coin} ${q.updated_at}`).join(""));
  for (const s of r.streams) lines.push(`    leader stream ${s.id}: ${s.state}${s.last_issue ? ` (${s.last_issue})` : ""} through ${s.coverage_through}`);
  lines.push(`(d) settlements to the owner: ${r.settlement_needs_owner.length}` + r.settlement_needs_owner.map((n) => `\n    ${n.dispatch_id} ${n.state} ${n.at}`).join(""));
  lines.push(`(e) clean streak since ${r.streak.start}: ${r.streak.clean_days} days, day ${r.streak.day_of_7} of ${r.streak.required_days}` +
    (r.streak.last_reset ? ` (last reset: ${r.streak.last_reset.kind} ${r.streak.last_reset.what} at ${r.streak.last_reset.at}, ${r.streak.last_reset.id})` : ""));
  lines.push(`(f) ${r.verdict}` + (r.reasons.length ? ":\n" + r.reasons.map((x) => `    - ${x}`).join("\n") : ""));
  return lines.join("\n");
}

async function main(argv) {
  const args = parseArgs(argv, { strategy: "value", since: "value", now: "value", json: "flag", "sql-only": "flag", input: "value" });
  const strategyId = Number(args.strategy);
  if (!Number.isInteger(strategyId) || strategyId <= 0) throw new Error("--strategy <id> is required (a positive integer)");
  const sinceMs = args.since === undefined ? undefined : parseTime(args.since, "since");
  const nowMs = args.now === undefined ? Date.now() : parseTime(args.now, "now");
  const { text, params } = buildQuery(strategyId, sinceMs);
  if (args["sql-only"]) { process.stdout.write(readOnlyScript(text, params)); return 0; }
  const report = await loadReport({ databaseUrl: process.env.DATABASE_URL, input: args.input, text, params });
  const result = evaluate(report, { nowMs, sinceMs });
  process.stdout.write((args.json ? JSON.stringify(result, null, 2) : render(result)) + "\n");
  return result.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`copy-acceptance: ${describeError(error)}`); process.exitCode = 2; });
}
