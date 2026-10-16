// Copy harness — the gate's two-part criteria (pure; unit-tested in criteria.test.mjs).
// Nothing here reads the network, the database or a secret.
//
// 1. Evidence without the testnet dex fan-out. Every order's account observation
//    subscribes `openOrders` once per perp venue (perpDexs: the main dex "" and each
//    HIP-3 dex) plus one `allDexsClearinghouseState`, for the follower and for the
//    leader. Testnet lists ~270 venues, mainnet 11: on testnet that fan-out is most of
//    the evidence (gate run 9: ws_messages ~3.2 s summed per role). The gate judges a
//    testnet order on its evidence minus the fan-out's share of the critical path,
//    and a mainnet order on its raw evidence; both numbers are always shown.
// 2. Signal latency in two parts: leader fill → dispatch created (the source's REST
//    poll: a harness fact on testnet) and dispatch created → order sent (ours).

import { MAINNET_EVIDENCE_WINDOW_MS, evidenceWindowLabel, percentile } from "./lib.mjs";

/** Subscriptions every observation makes whatever the venue count: the aggregate
 * state (`allDexsClearinghouseState`) and the main dex's ("") `openOrders`. */
export const FIXED_SUBSCRIPTIONS = 2;
/** Mainnet's perp venues (perpDexs entries, the main dex included), 2026-10-14. */
export const MAINNET_DEXES = 11;
/** Venues one socket carries before the observation splits them over sockets
 * (live-account-ws-source.ts BATCH; read-only copy). */
export const VENUES_PER_SOCKET = 90;

/** The subscriptions of one role's observation over `venues` perp venues, and the
 * share of them that is the per-dex fan-out (every venue but the main dex). */
export function fanoutShare(venues) {
  if (!Number.isSafeInteger(venues) || venues < 1) return null;
  const subscriptions = venues + 1, fanout = subscriptions - FIXED_SUBSCRIPTIONS;
  return { subscriptions, fanout, share: fanout / subscriptions };
}

const spanOf = (order, name) => (order.spans ?? []).find((s) => s.span === name) ?? null;
const total = (s) => Number(s?.totalMs) || 0;

/**
 * The part of an order's evidence that is the dex fan-out, and the evidence without it.
 *
 * Read from the order's spans (LiveSpanRecorder.summary: per span and role, its count,
 * summed total, first start and last end; live-execution-diagnostics.ts). The follower's
 * and the leader's observations (`observer_ws:<role>`) run at the same time, and each
 * role's sockets (`count` of its `ws_messages`, 3 on testnet) run at the same time too,
 * so summed totals overlap: the attribution follows the critical path instead.
 *
 * Per role r:
 *   per-socket subscribe path = (ws_messages + quota_subscribe_queue + quota_subscribe_tx) / sockets
 *     (ws_messages: the subscribe frames, their acks and each venue's snapshot;
 *      quota_subscribe_*: the meter charge for that subscription list; its lock is inside its tx);
 *   fan-out_r = share × per-socket subscribe path, at most observer_ws:r's own length;
 * the observation ends when the later role does (end_r = observer_ws:r's last end), so
 *   fanoutMs = max_r end_r − max_r (end_r − fan-out_r)   (how much earlier the order's
 *     observation would end without the fan-out), at most the evidence itself.
 * Unit cost: fanoutMs over the fan-out venues one socket of the critical role carried
 * (ms per dex). Projection: one mainnet socket carries every mainnet venue, so
 *   projectedMs = adjustedMs + unit × (mainnetDexes − 1).
 *
 * @param {{ evidenceMs: number, network?: string, spans?: object[] }} order
 * @param {{ venues: number | null, mainnetDexes?: number }} dexes  venues: perpDexs length of the run's network
 */
export function dexFanout(order, { venues, mainnetDexes = MAINNET_DEXES } = {}) {
  const raw = order.evidenceMs;
  const base = { network: order.network ?? null, rawMs: raw, venues: venues ?? null, mainnetDexes };
  // The raw number is judged on mainnet, and wherever the network or the venue count is unknown.
  if (order.network !== "testnet") return { ...base, applied: false, reason: order.network === "mainnet" ? "mainnet: raw evidence" : "network unknown: raw evidence", judgedMs: raw };
  const share = fanoutShare(venues);
  if (!share) return { ...base, applied: false, reason: "dex count unknown: raw evidence", judgedMs: raw };
  const roles = [];
  for (const s of order.spans ?? []) {
    const [name, role] = String(s.span).split(":");
    if (name !== "observer_ws" || !role) continue;
    const messages = spanOf(order, `ws_messages:${role}`);
    const sockets = Math.max(1, Number(messages?.count) || 1);
    const path = (total(messages) + total(spanOf(order, `quota_subscribe_queue:${role}`)) + total(spanOf(order, `quota_subscribe_tx:${role}`))) / sockets;
    const fanoutMs = Math.min(share.share * path, Math.max(0, s.lastEndMs - s.firstAtMs));
    roles.push({ role, sockets, endMs: s.lastEndMs, subscribePathMs: round(path), fanoutMs: round(fanoutMs) });
  }
  if (!roles.length) return { ...base, ...share, applied: true, roles, criticalRole: null, fanoutMs: 0, adjustedMs: raw, judgedMs: raw, unitMsPerDex: null,
    projectedMainnetMs: null, reason: "no observer_ws span: nothing to remove" };
  const end = Math.max(...roles.map((r) => r.endMs));
  const shortened = Math.max(...roles.map((r) => r.endMs - r.fanoutMs));
  const fanoutMs = round(Math.min(raw, Math.max(0, end - shortened)));
  const critical = roles.reduce((a, b) => (b.endMs > a.endMs ? b : a));
  const perSocket = share.fanout / critical.sockets;
  const unit = perSocket > 0 ? fanoutMs / perSocket : null;
  const adjustedMs = round(raw - fanoutMs);
  // Mainnet's fan-out venues per socket: all of them on one socket up to VENUES_PER_SOCKET.
  const mainnetPerSocket = Math.max(0, mainnetDexes - 1) / (mainnetDexes > VENUES_PER_SOCKET ? critical.sockets : 1);
  const projectedMainnetMs = unit === null ? null : round(adjustedMs + unit * mainnetPerSocket);
  return { ...base, ...share, applied: true, roles, criticalRole: critical.role, fanoutMs, adjustedMs, judgedMs: adjustedMs,
    unitMsPerDex: unit === null ? null : round(unit, 2), projectedMainnetMs };
}
const round = (x, d = 0) => Number(x.toFixed(d));

/** Each order with its fan-out (`fanout`) and the number the gate judges (`judgedMs`). */
export function judgeOrders(orders, dexes) {
  return orders.map((o) => { const fanout = dexFanout(o, dexes); return { ...o, judgedMs: fanout.judgedMs, fanout }; });
}

/** p50/p95/max of the judged, raw and projected numbers, how many judged ones reached `maxMs`, and the fan-out unit cost. */
export function judgedStats(orders, maxMs) {
  const stat = (xs) => ({ p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: xs.length ? Math.max(...xs) : null });
  const judged = orders.map((o) => o.judgedMs ?? o.evidenceMs);
  const projected = orders.map((o) => o.fanout?.projectedMainnetMs).filter(Number.isFinite);
  const units = orders.map((o) => o.fanout?.unitMsPerDex).filter(Number.isFinite);
  return { orders: orders.length, over: judged.filter((x) => x >= maxMs).length, raw: stat(orders.map((o) => o.evidenceMs)), judged: stat(judged),
    adjusted: orders.some((o) => o.fanout?.applied && o.fanout.fanoutMs > 0), fanout: stat(orders.map((o) => o.fanout?.fanoutMs ?? 0)),
    unitMsPerDex: stat(units), projectedMainnet: stat(projected) };
}

/** The evidence check's detail: the window in force, the judged number, then the raw one, the fan-out and the mainnet projection. */
export function evidenceDetail(orders, maxMs, dexes, windowMs = MAINNET_EVIDENCE_WINDOW_MS) {
  const s = judgedStats(orders, maxMs), f = (v) => (v === null ? "—" : String(v));
  const triple = (t) => `p50 ${f(t.p50)} / p95 ${f(t.p95)} / max ${f(t.max)}`;
  const parts = [`${evidenceWindowLabel(windowMs)}: ${s.orders} order(s), judged ${triple(s.judged)} ms, ${s.over} at or over ${maxMs}`, `raw ${triple(s.raw)} ms`];
  if (s.adjusted) parts.push(`judged = raw minus the testnet dex fan-out (${dexes.venues} venues): fan-out ${triple(s.fanout)} ms, ${f(s.unitMsPerDex.max)} ms/dex; ` +
    `mainnet projection (${dexes.mainnetDexes ?? MAINNET_DEXES} dexes) ${triple(s.projectedMainnet)} ms`);
  else {
    const reasons = [...new Set(orders.map((o) => o.fanout?.reason).filter(Boolean))];
    parts.push(`judged = raw${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
  }
  return parts.join("; ");
}

/** The two parts of the signal latency per dispatch (s): leader fill → dispatch created
 * (the source's poll; a measurement only) and dispatch created → order sent (ours; the one
 * any latency judgement uses). Dispatches never sent count in the first part only. */
export function signalLatency(dispatches) {
  const stat = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? Number(Math.max(...xs).toFixed(2)) : null });
  const created = [], sent = [];
  for (const d of dispatches) {
    const at = d.createdAt > 0 ? d.createdAt : d.receivedAt;
    if (!(at > 0) || !(d.leaderTime > 0)) continue;
    created.push((at - d.leaderTime) / 1000);
    if (d.sentAt > 0) sent.push((d.sentAt - at) / 1000);
  }
  return { leaderToCreated: stat(created), createdToSent: stat(sent) };
}
const pct = (xs, p) => { const v = percentile(xs, p); return v === null ? null : Number(v.toFixed(2)); };

/**
 * Whether a leader order without a dispatch is the harness's timing rather than a defect:
 * the scenario ended (or aborted) before the copy's source could have read it.
 *   - the stream's last completed read covered fills through `coverageThrough` (ms;
 *     copy_live_source_streams.coverage_through, read before the dispatches): an order
 *     after it was not read yet → harness_timing; at or before it → covered, a FAIL;
 *   - with no coverage to read (no database, no stream row), an order later than the
 *     scenario's end minus one source poll interval (`endAt − pollMs`) → harness_timing.
 * Null: the order should have a dispatch.
 * @param {number} time the leader order's time (ms)
 * @param {{ coverageThrough?: number | null, endAt?: number, pollMs?: number } | null | undefined} timing
 */
export function harnessTimingCause(time, timing) {
  if (!timing || !Number.isFinite(time)) return null;
  const { coverageThrough = null, endAt, pollMs } = timing;
  if (Number.isFinite(coverageThrough)) return time > coverageThrough ? { rule: "after_last_source_read", coverageThrough: new Date(coverageThrough).toISOString() } : null;
  if (Number.isFinite(endAt) && Number.isFinite(pollMs) && pollMs > 0 && time > endAt - pollMs)
    return { rule: "within_last_poll_interval", endAt: new Date(endAt).toISOString(), pollMs };
  return null;
}
