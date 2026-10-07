// Copy harness — the reconciliation rules (pure; reconcile.mjs gathers the
// sources, harness.test.mjs feeds fixtures). Nothing here reads the network.
//
// Sources: L leader fills, D Orbie's dispatch rows (null without the
// database), F follower fills, C both accounts' positions, plus the
// follower's leverage per coin (activeAssetData) and each coin's szDecimals.
//
// A run FAILS when (each listed with its detail):
//   leader_order_without_dispatch    a leader order has no dispatch row (needs D);
//   signal_expired                   a leg was lost to signal age;
//   refusal_not_allowed              a leg was refused for a reason outside the allowlist;
//   leader_leg_without_follower_fill a leg that was not refused has no follower fill
//                                    (pending, sent and unanswered, or filled elsewhere);
//   executed_without_follower_fill   an execution says filled, the follower has no fill;
//   follower_side_mismatch           an open filled on the other side;
//   fixed_size_mismatch              an open's fill is not per-trade USD / limit price at szDecimals;
//   follower_leverage_above_cap      the follower's leverage on a coin is above the cap;
//   direction_mismatch               a coin's position has the other direction;
//   follower_not_flat                the leader ended flat and the follower holds a position;
//   follower_order_without_dispatch  the follower traded an order that is neither a dispatched
//                                    leg nor a stop's / owner's reduce-only close (a double send
//                                    after a worker restart, or a stranger's order; needs D).

/** Refusals a run may show: the follower held nothing to reduce, or the
 * market can't be traded (a HIP-3 dex). Merged legs are judged by their lead. */
export const DEFAULT_ALLOWED_REFUSALS = Object.freeze([{ reason: "no_follower_position" }, { reason: "live_market_hip3_unsupported" }]);
/** `reason` or `reason:COIN` (a refusal expected for one coin only, e.g. a scenario's). */
export function parseAllowedRefusals(values) {
  return values.map((value) => { const [reason, coin] = String(value).split(":"); if (!/^[a-z][a-z0-9_]*$/.test(reason ?? "")) throw new Error(`bad refusal ${value}`); return coin ? { reason, coin } : { reason }; });
}
const allowed = (list, reason, coin) => list.some((a) => a.reason === reason && (!a.coin || a.coin === coin));

const scale = (d) => 10 ** d;
const floorTo = (x, d) => Math.floor(x * scale(d) + 1e-9) / scale(d);
const ceilTo = (x, d) => Math.ceil(x * scale(d) - 1e-9) / scale(d);
const fmt = (x, d) => x.toFixed(d).replace(/\.?0+$/, "") || "0";
/**
 * The size a fixed-amount open sends: per-trade USD / limit price, floored
 * to szDecimals; under the exchange minimum it is rounded up to the minimum
 * while that stays within the per-trade maximum (null: refused).
 */
export function fixedOrderSize({ perTradeUsd, maxPerTradeUsd, minOrderUsd = 10 }, limitPx, szDecimals) {
  const size = floorTo(perTradeUsd / limitPx, szDecimals);
  if (size * limitPx >= minOrderUsd - 1e-9) return fmt(size, szDecimals);
  const atMinimum = ceilTo(minOrderUsd / limitPx, szDecimals);
  return atMinimum * limitPx <= (maxPerTradeUsd ?? perTradeUsd) + 1e-9 ? fmt(atMinimum, szDecimals) : null;
}

export function evaluate(input) {
  const { leaderFills, dispatches, followerFills, leaderPositions, followerPositions, followerLeverage = new Map(), szDecimals = new Map(), rules = {}, closeCloids = new Set() } = input;
  const allowList = rules.allowedRefusals ?? DEFAULT_ALLOWED_REFUSALS;
  const failures = [];
  const fail = (check, detail) => failures.push({ check, ...detail });
  const db = dispatches !== null;
  const rows = dispatches ?? [];
  const leaderOrders = new Map();
  for (const f of leaderFills) { const o = leaderOrders.get(f.oid) ?? { oid: f.oid, coin: f.coin, side: f.side, time: f.time, tids: [] }; o.tids.push(String(f.tid)); leaderOrders.set(f.oid, o); }
  const byTid = new Map(rows.map((d) => [d.tid, d]));
  if (db) for (const o of leaderOrders.values()) if (!o.tids.some((tid) => byTid.has(tid))) fail("leader_order_without_dispatch", { oid: o.oid, coin: o.coin, side: o.side, at: new Date(o.time).toISOString() });
  for (const d of rows) if (/signal_expired/.test(d.reason)) fail("signal_expired", { dispatch: d.id, reason: d.reason });
  const fillsByCloid = new Map();
  for (const f of followerFills) if (f.cloid) fillsByCloid.set(f.cloid.toLowerCase(), [...(fillsByCloid.get(f.cloid.toLowerCase()) ?? []), f]);
  const fillsOf = (d) => (d.cloid ? fillsByCloid.get(d.cloid.toLowerCase()) : undefined) ?? [];
  const mergedInto = new Set(rows.filter((d) => d.state === "refused" && d.reason === "merged_into_adjustment" && d.adjustmentId).map((d) => d.adjustmentId));

  for (const d of rows) {
    // Every leg is either refused for an allowed reason, merged into a lead
    // that is judged itself, or followed by the follower's fill.
    if (d.state === "refused") {
      if (d.reason === "merged_into_adjustment") { if (!rows.some((x) => x.id === d.adjustmentId)) fail("refusal_not_allowed", { dispatch: d.id, reason: d.reason, detail: "lead missing" }); }
      else if (!/signal_expired/.test(d.reason) && !allowed(allowList, d.reason, d.coin)) fail("refusal_not_allowed", { dispatch: d.id, coin: d.coin, leg: d.leg, reason: d.reason });
      continue;
    }
    const fills = fillsOf(d);
    if (!fills.length) { fail(["filled", "partially_filled"].includes(d.executionState) || d.state === "settled" ? "executed_without_follower_fill" : "leader_leg_without_follower_fill",
      { dispatch: d.id, coin: d.coin, leg: d.leg, state: d.state, executionState: d.executionState, cloid: d.cloid || null }); continue; }
    const lead = leaderFills.find((f) => String(f.tid) === d.tid);
    if (lead && d.leg === "open" && fills.some((f) => f.side !== lead.side)) fail("follower_side_mismatch", { dispatch: d.id, leader: lead.side, follower: fills.map((f) => f.side) });
    // Fixed sizing: an open on its own (not a merged adjustment) fills its fixed amount.
    if (rules.sizing && d.leg === "open" && !mergedInto.has(d.id) && Number(d.limitPx) > 0 && szDecimals.has(d.coin)) {
      const dec = szDecimals.get(d.coin), filled = fills.reduce((sum, f) => sum + Number(f.sz), 0), lot = 1 / scale(dec);
      const exact = rules.sizing.perTradeUsd / Number(d.limitPx), expected = fixedOrderSize(rules.sizing, Number(d.limitPx), dec);
      const ok = Math.abs(filled - exact) <= lot + 1e-9 || (expected !== null && Math.abs(filled - Number(expected)) <= 1e-9);
      if (!ok) fail("fixed_size_mismatch", { dispatch: d.id, coin: d.coin, filled: fmt(filled, dec), expected, limitPx: d.limitPx, perTradeUsd: rules.sizing.perTradeUsd });
    }
  }

  if (db) {
    const legCloids = new Set(rows.filter((d) => d.cloid).map((d) => d.cloid.toLowerCase())), seen = new Set();
    for (const f of followerFills) {
      const cloid = f.cloid?.toLowerCase() ?? null, key = cloid ?? `oid:${f.oid}`;
      if (seen.has(key) || (cloid && (legCloids.has(cloid) || closeCloids.has(cloid)))) continue;
      seen.add(key); fail("follower_order_without_dispatch", { cloid, oid: f.oid, coin: f.coin, side: f.side });
    }
  }

  if (rules.maxLeverage) for (const [coin, leverage] of followerLeverage) if (Number(leverage) > rules.maxLeverage) fail("follower_leverage_above_cap", { coin, leverage, cap: rules.maxLeverage });

  for (const coin of new Set([...leaderPositions.keys(), ...followerPositions.keys()])) {
    const l = Math.sign(leaderPositions.get(coin) ?? 0), c = Math.sign(followerPositions.get(coin) ?? 0);
    if ((!db || rows.some((d) => d.coin === coin)) && l !== c) fail("direction_mismatch", { coin, leader: leaderPositions.get(coin) ?? 0, follower: followerPositions.get(coin) ?? 0 });
  }
  const leaderFlat = [...leaderPositions.values()].every((v) => !v);
  if (leaderFlat) for (const [coin, size] of followerPositions) if (size && !failures.some((f) => f.check === "direction_mismatch" && f.coin === coin)) fail("follower_not_flat", { coin, follower: size });
  return { failures, fillsByCloid, leaderOrders };
}
