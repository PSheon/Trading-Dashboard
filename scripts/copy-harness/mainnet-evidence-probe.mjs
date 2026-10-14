// Copy harness — the mainnet evidence probe (read-only, TEST ONLY).
//
// Replaces the testnet projection of an order's evidence on mainnet with a
// measurement: apps/api/test/manual-mainnet-evidence-probe.e2e-spec.ts runs the
// order path's real provider epoch (LiveProviderReadEpoch.collect with the
// shared reads, the account observer and its WebSocket account source, the
// market resolver and the risk provider, on an original PostgresLiveRiskScope
// session metering every read through HyperliquidGlobalTransport and
// PostgresHyperliquidQuota) against Hyperliquid MAINNET, read-only: info POSTs
// and WS subscriptions only. Nothing is signed, no exchange endpoint is
// reachable from it (its fetch and socket wrappers refuse anything else).
// It also measures the fill index lag (userFillsByTime) of a busy public address.
//
//   node scripts/copy-harness/mainnet-evidence-probe.mjs run [--runner <local-db-test.sh>] [--runs 20] [--close-runs 0]
//        [--pace-ms 65000] [--rtt-ms 8] [--fill-lag-min 10] [--no-evidence] [--no-fill-lag] [--out <json>]
//   node scripts/copy-harness/mainnet-evidence-probe.mjs report <json>
//
// `run` starts the spec through the isolated api test runner (a random
// database, migrated, dropped afterwards): `--runner` is a wrapper that
// supplies TEST_DATABASE_ADMIN_URL and is called as `<runner> <worktree> <args…>`
// (the local-db-test.sh pattern); without it, scripts/test-api-isolated.mjs
// with the caller's environment. Then it prints the report of the JSON the
// spec wrote. Everything below the CLI is pure (mainnet-evidence-probe.test.mjs).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { percentile } from "./lib.mjs";

/** n / p50 / p95 / max of the finite numbers (nearest rank); nulls for none. */
export function spread(values) {
  const xs = values.filter(Number.isFinite);
  return { n: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: xs.length ? Math.max(...xs) : null };
}

/** Total length of the union of [start, end) intervals. */
export function unionMs(intervals) {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, end = -Infinity, start = -Infinity;
  for (const [a, b] of sorted) {
    if (a > end) { if (end > start) total += end - start; start = a; end = b; }
    else end = Math.max(end, b);
  }
  if (end > start) total += end - start;
  return total;
}

const QUOTA = /^quota_([a-z_]+)_(queue|lock|tx)$/;

/**
 * The shared meter's work in a run's spans (postgres-hyperliquid-quota.ts:
 * per meter request `quota_<kind>_queue` (waiting behind the session's earlier
 * meter requests), `_lock` (the quota row's lock, inside the transaction) and
 * `_tx` (the whole transaction)), split at the evidence clock's start
 * (`clockAtMs`, recorder time): a span that starts before it and ends after
 * counts only its part inside. `wallMs`: the time inside the clock with at
 * least one meter request queued or in its transaction (what removing the
 * meter from the clock can save at most). `endAtMs`: the clock's side ends
 * there (collect's return; the boundary reads after it are counted apart).
 */
export function quotaSpans(spans, clockAtMs, endAtMs = Infinity) {
  const part = (s, inside) => {
    const end = s.atMs + s.ms;
    if (inside) return Math.max(0, Math.min(end, endAtMs) - Math.max(s.atMs, clockAtMs));
    return Math.max(0, Math.min(end, clockAtMs) - s.atMs);
  };
  const side = (inside) => {
    const out = { requests: 0, txMs: 0, queueMs: 0, lockMs: 0, wallMs: 0, byKind: {} };
    const intervals = [];
    for (const s of spans) {
      const m = QUOTA.exec(s.name);
      if (!m) continue;
      const ms = part(s, inside);
      const touches = inside ? s.atMs + s.ms > clockAtMs && s.atMs < endAtMs : s.atMs < clockAtMs;
      if (!touches) continue;
      const [, kind, step] = m;
      const row = (out.byKind[kind] ??= { requests: 0, txMs: 0, queueMs: 0, lockMs: 0 });
      if (step === "tx") { out.requests++; row.requests++; }
      out[`${step}Ms`] += ms; row[`${step}Ms`] += ms;
      if (step !== "lock") intervals.push(inside ? [Math.max(s.atMs, clockAtMs), Math.min(s.atMs + s.ms, endAtMs)] : [s.atMs, Math.min(s.atMs + s.ms, clockAtMs)]);
    }
    out.wallMs = unionMs(intervals);
    return out;
  };
  return { inClock: side(true), beforeClock: side(false) };
}

/** Per span name (and role): count, total, longest (as LiveSpanRecorder.summary). */
export function spanTable(spans) {
  const rows = new Map();
  for (const s of spans) {
    const key = s.role ? `${s.name}:${s.role}` : s.name, row = rows.get(key);
    if (!row) rows.set(key, { span: key, count: 1, totalMs: s.ms, maxMs: s.ms, firstAtMs: s.atMs, lastEndMs: s.atMs + s.ms });
    else { row.count++; row.totalMs += s.ms; row.maxMs = Math.max(row.maxMs, s.ms); row.firstAtMs = Math.min(row.firstAtMs, s.atMs); row.lastEndMs = Math.max(row.lastEndMs, s.atMs + s.ms); }
  }
  return [...rows.values()].sort((a, b) => a.firstAtMs - b.firstAtMs);
}

/**
 * One run's figures from what the spec recorded:
 *   raw.spans        LiveSpanRecorder.spans ({name, role?, atMs, ms}; recorder time)
 *   raw.timings      the epoch's LiveExecutionTiming marks (phase `collect`)
 *   raw.clockAtMs    the evidence clock's start (the shared reads' startedAt), recorder time
 *   raw.collectAtMs / raw.collectEndAtMs  collect's call and return, recorder time
 *   raw.rest         [{type, weight, status, ms}] every info POST actually sent
 *   raw.ws           {sockets, subscribes, unsubscribes, other, framesIn, bytesIn, subscriptionsByType}
 *   raw.dexes        perpDexs venues observed (the main dex included)
 *   raw.sentWeight / raw.paidWeight  the epoch's own count (LiveSharedReads)
 */
export function analyzeRun(raw) {
  const collectMs = raw.collectEndAtMs - raw.collectAtMs;
  const clock = Number.isFinite(raw.clockAtMs) ? raw.clockAtMs : null;
  const quota = clock === null ? null : quotaSpans(raw.spans, clock, raw.collectEndAtMs);
  // The exchange boundary's own provider reads after collect (signer and
  // submit gates: extraAgents twice, maxBuilderFee), each one meter request.
  const boundary = raw.boundary ? {
    ms: raw.boundary.endAtMs - raw.boundary.atMs, reads: raw.boundary.reads,
    quota: quotaSpans(raw.spans.filter((s) => s.atMs >= raw.boundary.atMs), raw.boundary.atMs, raw.boundary.endAtMs).inClock,
  } : null;
  const stages = Object.fromEntries((raw.timings ?? []).filter((t) => t.phase === "collect").map((t) => [t.stage, t.elapsedMs]));
  const collectRest = raw.rest.filter((r) => !r.boundary);
  const restWeight = collectRest.reduce((sum, r) => sum + r.weight, 0);
  const byType = {};
  for (const r of collectRest) { const row = (byType[r.type] ??= { requests: 0, weight: 0 }); row.requests++; row.weight += r.weight; }
  return {
    run: raw.run, case: raw.case, ok: raw.ok, ...(raw.error ? { error: raw.error } : {}),
    // live_account_observation_changed: production's changedReads and the probe's key-path diffs.
    ...(raw.observationChange ? { change: raw.observationChange } : {}),
    collectMs,
    // From the clock's start (the first wave's dispatch) to collect's return:
    // the age the order's 5 s window must already hold when collect returns.
    evidenceAgeMs: clock === null ? null : raw.collectEndAtMs - clock,
    preClockMs: clock === null ? null : clock - raw.collectAtMs,
    stages, spans: spanTable(raw.spans),
    dexes: raw.dexes ?? null,
    rest: { requests: collectRest.length, weight: restWeight, byType, sentWeight: raw.sentWeight ?? null, paidWeight: raw.paidWeight ?? null,
      statuses: [...new Set(raw.rest.map((r) => r.status))] },
    ws: raw.ws,
    quota, boundary,
    // collect plus the boundary reads: the provider part of an order's evidence window.
    providerAgeMs: clock === null || !raw.boundary ? null : raw.boundary.endAtMs - clock,
    // The evidence epoch reads no fills (no userFills*/userFillsByTime in collect).
    fillIndexReadMs: raw.rest.filter((r) => r.type.startsWith('userFills')).reduce((sum, r) => sum + (r.ms ?? 0), 0),
    // The account observer's freshness checks (freshnessTable rows, the refusals),
    // each all-venue snapshot's provider times against our clock (stateTimeLags
    // with its account), and the wall clock against the monotonic one over the run.
    freshness: raw.freshness ?? null, stateLags: raw.stateLags ?? [], wallDriftMs: raw.wallDriftMs ?? null,
  };
}

/** p50 / p95 / max over the runs of every figure the report shows. */
export function aggregateRuns(runs) {
  const ok = runs.filter((r) => r.ok);
  const pick = (f) => spread(ok.map(f));
  const stageNames = [...new Set(ok.flatMap((r) => Object.keys(r.stages)))];
  const spanNames = [...new Set(ok.flatMap((r) => r.spans.map((s) => s.span)))];
  const kinds = [...new Set(ok.flatMap((r) => Object.keys(r.quota?.inClock.byKind ?? {})))];
  const restTypes = [...new Set(ok.flatMap((r) => Object.keys(r.rest.byType)))];
  return {
    runs: runs.length, ok: ok.length, errors: runs.filter((r) => !r.ok).map((r) => ({ run: r.run, error: r.error, ...(r.change ? { change: r.change } : {}) })),
    collectMs: pick((r) => r.collectMs), evidenceAgeMs: pick((r) => r.evidenceAgeMs), preClockMs: pick((r) => r.preClockMs),
    stages: Object.fromEntries(stageNames.map((s) => [s, pick((r) => r.stages[s])])),
    spans: Object.fromEntries(spanNames.map((name) => [name, {
      count: pick((r) => r.spans.find((s) => s.span === name)?.count ?? 0),
      totalMs: pick((r) => r.spans.find((s) => s.span === name)?.totalMs ?? 0),
      maxMs: pick((r) => r.spans.find((s) => s.span === name)?.maxMs ?? 0),
    }])),
    dexes: [...new Set(ok.map((r) => r.dexes))],
    restRequests: pick((r) => r.rest.requests), restWeight: pick((r) => r.rest.weight),
    restByType: Object.fromEntries(restTypes.map((t) => [t, pick((r) => r.rest.byType[t]?.weight ?? 0)])),
    wsSockets: pick((r) => r.ws.sockets), wsSubscribes: pick((r) => r.ws.subscribes), wsUnsubscribes: pick((r) => r.ws.unsubscribes),
    wsCommandsOut: pick((r) => r.ws.subscribes + r.ws.unsubscribes + r.ws.other), wsFramesIn: pick((r) => r.ws.framesIn), wsBytesIn: pick((r) => r.ws.bytesIn),
    quotaInClock: { requests: pick((r) => r.quota.inClock.requests), txMs: pick((r) => r.quota.inClock.txMs), queueMs: pick((r) => r.quota.inClock.queueMs),
      lockMs: pick((r) => r.quota.inClock.lockMs), wallMs: pick((r) => r.quota.inClock.wallMs),
      byKind: Object.fromEntries(kinds.map((k) => [k, { requests: pick((r) => r.quota.inClock.byKind[k]?.requests ?? 0), txMs: pick((r) => r.quota.inClock.byKind[k]?.txMs ?? 0) }])) },
    quotaBeforeClock: { requests: pick((r) => r.quota.beforeClock.requests), txMs: pick((r) => r.quota.beforeClock.txMs), wallMs: pick((r) => r.quota.beforeClock.wallMs) },
    fillIndexReadMs: pick((r) => r.fillIndexReadMs),
    boundaryMs: pick((r) => r.boundary?.ms), boundaryQuotaTxMs: pick((r) => r.boundary?.quota.txMs), boundaryQuotaWallMs: pick((r) => r.boundary?.quota.wallMs),
    boundaryReads: Object.fromEntries([...new Set(ok.flatMap((r) => (r.boundary?.reads ?? []).map((b) => b.type)))].map((t) => [t,
      pick((r) => { const reads = (r.boundary?.reads ?? []).filter((b) => b.type === t); return reads.length ? Math.max(...reads.map((b) => b.ms)) : null; })])),
    providerAgeMs: pick((r) => r.providerAgeMs),
    ...freshnessAggregate(runs),
  };
}

/** Over every run (a refused one too): the freshness refusals, each check's
 * largest age per run, each account's snapshot lags, the wall clock's drift. */
function freshnessAggregate(runs) {
  const sites = new Map(), lags = new Map();
  for (const r of runs) {
    for (const row of r.freshness?.checks ?? []) {
      const key = `${row.site}|${row.role}`, s = sites.get(key) ?? { site: row.site, role: row.role, runs: 0, maxAges: [], minAgeMs: Infinity, refused: 0 };
      s.runs++; s.maxAges.push(row.maxAgeMs); s.minAgeMs = Math.min(s.minAgeMs, row.minAgeMs); s.refused += row.refused; sites.set(key, s);
    }
    const byRole = new Map();
    for (const l of r.stateLags ?? []) {
      const top = byRole.get(l.role);
      if (!top || l.maxLagMs > top.maxLagMs) byRole.set(l.role, { ...l, minLagMs: Math.min(l.minLagMs, top?.minLagMs ?? Infinity) });
      else top.minLagMs = Math.min(top.minLagMs, l.minLagMs);
    }
    for (const [role, l] of byRole) {
      const row = lags.get(role) ?? { role, maxLags: [], minLagMs: Infinity, maxLagDexes: {} };
      row.maxLags.push(l.maxLagMs); row.minLagMs = Math.min(row.minLagMs, l.minLagMs);
      row.maxLagDexes[dexName(l.maxLagDex)] = (row.maxLagDexes[dexName(l.maxLagDex)] ?? 0) + 1; lags.set(role, row);
    }
  }
  return {
    freshnessFailures: runs.flatMap((r) => (r.freshness?.failures ?? []).map((f) => ({ run: r.run, ...f }))),
    freshness: [...sites.values()].map(({ maxAges, ...s }) => ({ ...s, maxAgeMs: spread(maxAges) })),
    stateLags: [...lags.values()].map(({ maxLags, ...l }) => ({ ...l, maxLagMs: spread(maxLags) })),
    wallDriftMs: spread(runs.map((r) => (r.wallDriftMs === null ? null : Math.abs(r.wallDriftMs)))),
  };
}

// --- which observation changed -----------------------------------------------------------------------

/** The epoch's final check re-reads these (live-shared-reads.ts evidenceFinalCheck):
 * the dex list is the same for every account, the rest are the observed account's own. */
export const ACCOUNT_INDEPENDENT_READS = new Set(["perpDexs"]);

// An array element's name in a path: a dex's or a coin's name, a [coin, value] pair's coin, else its index.
const elementLabel = (v, i) => Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : String(i))
  : v && typeof v === "object" ? (typeof v.name === "string" ? v.name : typeof v.coin === "string" ? v.coin : String(i)) : String(i);

/**
 * Where two provider answers differ, as key paths only (never a value): object
 * keys, array elements by their name (a dex's `name`, a balance's `coin`, a
 * pair's first string) or index, down to `depth`; at most `limit` paths.
 */
export function changedPaths(a, b, { depth = 4, limit = 12 } = {}) {
  const out = [];
  const walk = (x, y, path, d) => {
    if (out.length >= limit || isDeepStrictEqual(x, y)) return;
    const objects = x !== null && y !== null && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y);
    if (d >= depth || !objects) { out.push(path || "(whole answer)"); return; }
    if (Array.isArray(x)) {
      const mx = new Map(x.map((v, i) => [elementLabel(v, i), v])), my = new Map(y.map((v, i) => [elementLabel(v, i), v]));
      for (const k of new Set([...mx.keys(), ...my.keys()])) walk(mx.get(k), my.get(k), `${path}[${k}]`, d + 1);
    } else for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path ? `${path}.${k}` : k, d + 1);
  };
  walk(a, b, "", 0);
  return out;
}

/**
 * Which final-check read changed within one epoch, from the raw answers the
 * probe's fetch saw (`answers`: [{type, account: 'follower'|'leader'|'-', value}]
 * in arrival order): per read and account with at least two answers, its first
 * against its last (the first wave's and the final check's). `changedReads`:
 * what the epoch's LiveReadComparisonError named (production's own comparison);
 * only those reads are diffed ('unclassified' diffs all). The leader's spot
 * state is compared as production does: portfolioMarginEnabled alone.
 */
export function observationDiffs(answers, changedReads) {
  const wanted = changedReads.includes("unclassified") ? null : new Set(changedReads);
  const groups = new Map();
  for (const a of answers) {
    if (wanted && !wanted.has(a.type)) continue;
    const key = `${a.type}|${a.account}`;
    if (!groups.has(key)) groups.set(key, { read: a.type, account: a.account, values: [] });
    groups.get(key).values.push(a.value);
  }
  const out = [];
  for (const g of groups.values()) {
    const part = g.read === "spotClearinghouseState" && g.account === "leader" ? (v) => ({ portfolioMarginEnabled: v?.portfolioMarginEnabled === true }) : (v) => v;
    const scope = ACCOUNT_INDEPENDENT_READS.has(g.read) ? "account-independent" : "account-specific";
    if (g.values.length < 2) { out.push({ read: g.read, account: g.account, scope, answers: g.values.length, paths: null }); continue; }
    const paths = changedPaths(part(g.values[0]), part(g.values.at(-1)));
    if (paths.length) out.push({ read: g.read, account: g.account, scope, answers: g.values.length, paths });
  }
  return out;
}

/** `changed perpDexs = perpDexs/- (account-independent): [xyz].assetToStreamingOiCap[ETH]`. */
const renderChange = (c) => `changed ${c.changedReads.join(",")}` +
  (c.diffs?.length ? ` = ${c.diffs.map((d) => `${d.read}/${d.account} (${d.scope}): ${d.paths ? d.paths.join(" ") : `${d.answers} answer seen, no diff`}`).join("; ")}` : "");

// --- which freshness check refused --------------------------------------------------------------------

const FRESH_CALL = /this\.(fresh|freshProvider)\(([^()]*)\)/g;

/**
 * The account observer's freshness check a call came from
 * (live-account-observer.ts `fresh` / `freshProvider`), named by its source
 * text and line: `fresh(started)@L244`, `freshProvider(state.time)@L356`, with
 * `remaining:` in front when it is a read deadline's (`const remaining = () =>
 * { this.fresh(started); … }`). `stack`: the probe wrapper's Error stack
 * (source-mapped: the first observer frame is the caller); `sourceLines`: the
 * observer's source by line. Null when no observer frame is on the stack.
 */
export function freshnessCallSite(stack, sourceLines) {
  const m = /live-account-observer\.ts:(\d+):(\d+)/.exec(stack ?? "");
  if (!m) return null;
  const line = Number(m[1]), column = Number(m[2]), text = sourceLines[line - 1] ?? "";
  // V8 points a method call's frame at the method's name (1-based column).
  const calls = [...text.matchAll(FRESH_CALL)].map((c) => ({ kind: c[1], arg: c[2].trim(), nameAt: c.index + "this.".length + 1 }));
  const call = calls.find((c) => c.nameAt === column) ?? calls.filter((c) => c.nameAt <= column).at(-1) ?? calls[0];
  if (!call) return `L${line}`;
  return `${/const remaining = /.test(text) ? "remaining:" : ""}${call.kind}(${call.arg})@L${line}`;
}

/**
 * Why a freshness check refuses, as the observer decides it (`fresh`: `at`
 * must be an integer ≥ 0, not after `now`, at most `maxAgeMs` old;
 * `freshProvider`: the same, but `at` may be up to `skewMs` after `now`). Null
 * when it passes.
 */
export function freshnessReason({ kind, at, now, maxAgeMs, skewMs }) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(now)) return "not_integer";
  if (at < 0) return "negative";
  if (kind === "freshProvider" ? at > now + skewMs : now < at) return "ahead_of_clock";
  if (now - at > maxAgeMs) return "older_than_bound";
  return null;
}

/** Per check site and account: how many calls, the smallest and largest age
 * (now − at, ms; negative: a time after our clock) and how many refused. */
export function freshnessTable(checks) {
  const rows = new Map();
  for (const c of checks) {
    const key = `${c.site}|${c.role}`, row = rows.get(key);
    if (!row) rows.set(key, { site: c.site, role: c.role, n: 1, minAgeMs: c.ageMs, maxAgeMs: c.ageMs, refused: c.ok ? 0 : 1 });
    else { row.n++; row.minAgeMs = Math.min(row.minAgeMs, c.ageMs); row.maxAgeMs = Math.max(row.maxAgeMs, c.ageMs); if (!c.ok) row.refused++; }
  }
  return [...rows.values()];
}

/**
 * The provider `time` of each dex's state in one allDexsClearinghouseState
 * snapshot against our clock when the read returned (`receivedAt`): the
 * largest and smallest lag (receivedAt − time, ms) and their dexes ('' is the
 * main dex). Null without any state time.
 */
export function stateTimeLags(data, receivedAt) {
  const rows = Array.isArray(data?.clearinghouseStates) ? data.clearinghouseStates : [];
  const lags = rows.flatMap((row) => (Array.isArray(row) && Number.isSafeInteger(row[1]?.time) ? [{ dex: String(row[0]), lagMs: receivedAt - row[1].time }] : []));
  if (!lags.length) return null;
  const max = lags.reduce((a, b) => (b.lagMs > a.lagMs ? b : a)), min = lags.reduce((a, b) => (b.lagMs < a.lagMs ? b : a));
  return { dexes: lags.length, maxLagMs: max.lagMs, maxLagDex: max.dex, minLagMs: min.lagMs, minLagDex: min.dex };
}

const dexName = (d) => (d === "" ? "(main)" : d);
const renderFreshFailure = (f) => `${f.site} ${f.role}: age ${f.ageMs} ms (bound ${f.maxAgeMs}${f.kind === "freshProvider" ? `, ahead allowed ${f.skewMs}` : ""}) ${f.reason}`;

// --- the fill index lag -------------------------------------------------------------------------------

/** Pool-adjacent-violators: the non-decreasing least-squares fit of `ys`
 * (ordered by x). For 0/1 inclusion indicators ordered by age this is the
 * NPMLE of the lag's distribution function under current-status data. */
export function isotonic(ys) {
  const blocks = [];
  for (const y of ys) {
    blocks.push({ sum: y, n: 1 });
    while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).n > blocks.at(-1).sum / blocks.at(-1).n) {
      const last = blocks.pop(); blocks.at(-1).sum += last.sum; blocks.at(-1).n += last.n;
    }
  }
  return blocks.flatMap((b) => Array(b.n).fill(b.sum / b.n));
}

/**
 * The fill index lag of one address, read-only: every poll is one
 * `userFillsByTime(user, startTime = sentAt − windowMs)` call.
 *   polls  [{sentAt, receivedAt, startTime, tids: [tid…]}] (our clock, ms)
 *   fills  [{tid, time}] every fill any poll returned (its exchange time)
 * Current status: each poll and each fill stamped in its window (time ≥
 * startTime, and at least `settleMs` before the last poll so that a later poll
 * surely saw it) is one observation at age = sentAt − time, included or not:
 * P(included | age) is the lag's distribution function. Its isotonic fit gives
 * the quantiles. Per fill, the bracket: `upperMs` (first poll that returned it:
 * its receivedAt − time) and `lowerMs` (the last poll sent after its time that
 * did not: sentAt − time; null when none).
 * Ages are our clock minus the exchange's: a clock offset shifts every figure
 * by itself (the run records the host's NTP offset beside them).
 */
export function fillIndexLag(polls, fills, { settleMs = 30_000, quantiles = [0.5, 0.9, 0.99] } = {}) {
  const sorted = [...polls].sort((a, b) => a.sentAt - b.sentAt);
  const lastSent = sorted.at(-1)?.sentAt ?? 0;
  const known = new Map(fills.map((f) => [String(f.tid), f.time]));
  const observations = [];
  for (const poll of sorted) {
    const returned = new Set(poll.tids.map(String));
    for (const [tid, time] of known) {
      if (time < poll.startTime || time > lastSent - settleMs) continue;
      observations.push({ age: poll.sentAt - time, included: returned.has(tid) ? 1 : 0 });
    }
  }
  observations.sort((a, b) => a.age - b.age);
  const fitted = isotonic(observations.map((o) => o.included));
  const quantile = (q) => { const i = fitted.findIndex((f) => f >= q); return i < 0 ? null : observations[i].age; };
  // A bracket needs every poll after the fill's time: fills from before the
  // first poll (already in its window) have none.
  const firstSent = sorted[0]?.sentAt ?? Infinity, brackets = [];
  for (const [tid, time] of known) {
    if (time > lastSent - settleMs || time < firstSent) continue;
    const first = sorted.find((p) => p.tids.map(String).includes(tid));
    if (!first) continue;
    const misses = sorted.filter((p) => p.sentAt >= time && p.sentAt < first.sentAt && p.startTime <= time);
    brackets.push({ tid, upperMs: first.receivedAt - time, lowerMs: misses.length ? misses.at(-1).sentAt - time : null });
  }
  const upper = brackets.map((b) => b.upperMs), lower = brackets.flatMap((b) => (b.lowerMs === null ? [] : [b.lowerMs]));
  const neverMissed = brackets.filter((b) => b.lowerMs === null).length;
  return {
    polls: sorted.length, fills: brackets.length, observations: observations.length,
    lagMs: Object.fromEntries(quantiles.map((q) => [`p${Math.round(q * 100)}`, quantile(q)])),
    maxAgeExcluded: observations.filter((o) => !o.included).reduce((m, o) => Math.max(m, o.age), -Infinity),
    upperMs: { p50: percentile(upper, 0.5), p90: percentile(upper, 0.9), p99: percentile(upper, 0.99), max: upper.length ? Math.max(...upper) : null },
    lowerMs: { n: lower.length, p50: percentile(lower, 0.5), p90: percentile(lower, 0.9), p99: percentile(lower, 0.99), max: lower.length ? Math.max(...lower) : null },
    fillsNeverMissed: neverMissed,
    // The request's own round trip: the provider reads its index about half of it after `sentAt`.
    pollHttpMs: { p50: percentile(sorted.map((p) => p.receivedAt - p.sentAt), 0.5), max: sorted.length ? Math.max(...sorted.map((p) => p.receivedAt - p.sentAt)) : null },
  };
}

// --- the report ---------------------------------------------------------------------------------------

const f = (v) => (v === null || v === undefined ? "–" : String(Math.round(v)));
const triple = (s) => `${f(s.p50)} / ${f(s.p95)} / ${f(s.max)}`;

/** The text report of a probe result (the spec's JSON). */
export function renderReport(result) {
  const out = [];
  out.push(`MAINNET EVIDENCE PROBE  ${result.startedAt ?? ""}  (read-only; db rtt ${result.config?.dbRttMs ?? "?"} ms, pace ${result.config?.paceMs ?? "?"} ms)`);
  if (result.config) out.push(`  follower ${result.config.follower}  leader ${result.config.leader}  coin ${result.config.coin}`);
  for (const [name, c] of Object.entries(result.cases ?? {})) {
    const runs = c.runs.map(analyzeRun), a = aggregateRuns(runs);
    out.push("", `CASE ${name}: ${a.ok}/${a.runs} runs ok${a.errors.length ? `; errors: ${a.errors.map((e) => `#${e.run} ${e.error}`).join(", ")}` : ""}`);
    out.push("  per run: run  collect  age  preclock  quotaInClock(n/tx/wall)  rest(n/w)  ws(sock/sub/frames)  dexes  stages");
    for (const r of runs) {
      out.push(`   ${String(r.run).padStart(3)} ${r.ok ? "ok " : "ERR"} ${f(r.collectMs).padStart(6)} ${f(r.evidenceAgeMs).padStart(5)} ${f(r.preClockMs).padStart(5)}   ` +
        `${r.quota ? `${r.quota.inClock.requests}/${f(r.quota.inClock.txMs)}/${f(r.quota.inClock.wallMs)}` : "–"}`.padEnd(16) +
        ` ${r.rest.requests}/${r.rest.weight}`.padEnd(10) + ` ${r.ws.sockets}/${r.ws.subscribes}/${r.ws.framesIn}`.padEnd(14) + ` ${r.dexes ?? "–"}  ` +
        Object.entries(r.stages).map(([s, ms]) => `${s.replace(/^epoch_/, "")}=${ms}`).join(" ") + (r.error ? `  ${r.error}` : ""));
    }
    const changes = a.errors.filter((e) => e.change);
    if (changes.length) {
      out.push(`  observation changes (${changes.length}):`);
      for (const e of changes) out.push(`    #${e.run} ${renderChange(e.change)}`);
      const tally = {};
      for (const e of changes) for (const d of e.change.diffs ?? []) { const k = `${d.read}/${d.account} (${d.scope})`; tally[k] = (tally[k] ?? 0) + 1; }
      out.push(`    by read: ${Object.entries(tally).map(([k, n]) => `${k} ×${n}`).join(", ") || "–"}`);
    }
    if (a.freshnessFailures.length) {
      out.push(`  freshness refusals (${a.freshnessFailures.length}):`);
      for (const x of a.freshnessFailures) out.push(`    #${x.run} ${renderFreshFailure(x)}`);
    }
    if (a.freshness.length) {
      out.push("  freshness checks over all runs: each run's largest age (now − at) p50 / p95 / max ms; smallest age; refusals:");
      for (const s of a.freshness) out.push(`    ${`${s.site} ${s.role}`.padEnd(56)} ${triple(s.maxAgeMs)}   min ${f(s.minAgeMs)}   refused ${s.refused}/${s.runs} runs`);
      for (const l of a.stateLags) out.push(`    snapshot state time lag ${l.role.padEnd(9)} (read return − dex time): largest per run ${triple(l.maxLagMs)}, smallest ${f(l.minLagMs)}; largest on ${Object.entries(l.maxLagDexes).map(([d, n]) => `${d} ×${n}`).join(", ")}`);
      out.push(`    |wall − monotonic clock| over a run (ms)  ${triple(a.wallDriftMs)}`);
    }
    out.push("  p50 / p95 / max over ok runs:");
    out.push(`    collect total (ms)               ${triple(a.collectMs)}`);
    out.push(`    evidence age at return (ms)      ${triple(a.evidenceAgeMs)}   (clock start = first wave dispatch → collect returns)`);
    out.push(`    before the clock (ms)            ${triple(a.preClockMs)}`);
    for (const [s, v] of Object.entries(a.stages)) out.push(`    stage ${s.padEnd(26)} ${triple(v)}`);
    out.push(`    quota SQL in clock: requests     ${triple(a.quotaInClock.requests)}`);
    out.push(`    quota SQL in clock: Σ tx ms      ${triple(a.quotaInClock.txMs)}`);
    out.push(`    quota SQL in clock: Σ queue ms   ${triple(a.quotaInClock.queueMs)}`);
    out.push(`    quota SQL in clock: Σ lock ms    ${triple(a.quotaInClock.lockMs)}`);
    out.push(`    quota SQL in clock: wall ms      ${triple(a.quotaInClock.wallMs)}   (union of queue+tx)`);
    for (const [k, v] of Object.entries(a.quotaInClock.byKind)) out.push(`      ${k.padEnd(14)} n ${triple(v.requests)}  tx ms ${triple(v.txMs)}`);
    out.push(`    quota SQL before clock: n / tx / wall   ${triple(a.quotaBeforeClock.requests)} | ${triple(a.quotaBeforeClock.txMs)} | ${triple(a.quotaBeforeClock.wallMs)}`);
    out.push(`    REST requests                    ${triple(a.restRequests)}`);
    out.push(`    REST weight                      ${triple(a.restWeight)}`);
    for (const [t, v] of Object.entries(a.restByType)) out.push(`      ${t.padEnd(24)} ${triple(v)}`);
    out.push(`    WS sockets                       ${triple(a.wsSockets)}`);
    out.push(`    WS subscribes / unsubscribes     ${triple(a.wsSubscribes)} | ${triple(a.wsUnsubscribes)}`);
    out.push(`    WS commands out                  ${triple(a.wsCommandsOut)}`);
    out.push(`    WS messages in                   ${triple(a.wsFramesIn)}`);
    out.push(`    WS bytes in                      ${triple(a.wsBytesIn)}`);
    out.push(`    dexes (perpDexs venues)          ${a.dexes.join(", ")}`);
    out.push(`    fill-index lag reads (ms)        ${triple(a.fillIndexReadMs)}   (none in the evidence path)`);
    if (a.boundaryMs.n) {
      out.push(`    boundary reads after collect (ms) ${triple(a.boundaryMs)}   (extraAgents ×2, maxBuilderFee; each one meter request)`);
      for (const [t, v] of Object.entries(a.boundaryReads)) out.push(`      ${t.padEnd(24)} ${triple(v)}   (slowest of the run)`);
      out.push(`      quota SQL: Σ tx / wall ms      ${triple(a.boundaryQuotaTxMs)} | ${triple(a.boundaryQuotaWallMs)}`);
      out.push(`    provider age: clock → last boundary read (ms)  ${triple(a.providerAgeMs)}`);
    }
    out.push("    spans (count | Σ ms | max ms):");
    for (const [s, v] of Object.entries(a.spans)) out.push(`      ${s.padEnd(34)} ${triple(v.count)} | ${triple(v.totalMs)} | ${triple(v.maxMs)}`);
  }
  if (result.fillLag) {
    const fl = result.fillLag, lag = fillIndexLag(fl.polls, fl.fills, { settleMs: fl.settleMs ?? 30_000 });
    out.push("", `FILL INDEX LAG  ${fl.address}  ${lag.polls} polls every ~${fl.pollMs} ms, window ${fl.windowMs} ms, ${lag.fills} fills, ${lag.observations} observations`);
    out.push(`  current-status (isotonic) lag: p50 ${f(lag.lagMs.p50)}  p90 ${f(lag.lagMs.p90)}  p99 ${f(lag.lagMs.p99)} ms;  oldest fill a poll missed: ${f(lag.maxAgeExcluded)} ms`);
    out.push(`  (age = our send time − the fill's exchange time; a poll's HTTP round trip p50 ${f(lag.pollHttpMs.p50)} ms, max ${f(lag.pollHttpMs.max)} ms)`);
    out.push(`  per fill, first poll that returned it (upper bound): p50 ${f(lag.upperMs.p50)}  p90 ${f(lag.upperMs.p90)}  p99 ${f(lag.upperMs.p99)}  max ${f(lag.upperMs.max)} ms`);
    out.push(`  per fill, last poll that missed it (lower bound, n ${lag.lowerMs.n}): p50 ${f(lag.lowerMs.p50)}  p90 ${f(lag.lowerMs.p90)}  p99 ${f(lag.lowerMs.p99)}  max ${f(lag.lowerMs.max)} ms`);
    if (fl.restWeight !== undefined) out.push(`  REST weight used ${fl.restWeight}; statuses ${JSON.stringify(fl.statuses ?? [])}`);
  }
  if (result.clockOffset) out.push("", `host clock vs NTP: ${result.clockOffset}`);
  return out.join("\n");
}

// --- the CLI ------------------------------------------------------------------------------------------

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key.startsWith("no-")) out[key.slice(3)] = false;
    else out[key] = argv[++i];
  }
  return out;
}

async function main(argv) {
  const opts = args(argv), [command, file] = opts._;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (command === "report" && file) { console.log(renderReport(JSON.parse(readFileSync(file, "utf8")))); return 0; }
  if (command !== "run") { console.error("usage: mainnet-evidence-probe.mjs run [--runner <script>] [--runs N] … | report <json>"); return 2; }
  const out = resolve(opts.out ?? resolve(root, ".claude/logs/copy-harness", `mainnet-evidence-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  mkdirSync(dirname(out), { recursive: true });
  // The host clock against NTP (read-only), for the fill lag's ages.
  const sntp = spawnSync("sntp", ["time.apple.com"], { encoding: "utf8", timeout: 15_000 });
  const env = { ...process.env, HL_MAINNET_PROBE: "1", HL_MAINNET_PROBE_OUT: out,
    COPY_HARNESS_DB_RTT_MS: String(opts["rtt-ms"] ?? process.env.COPY_HARNESS_DB_RTT_MS ?? 8),
    ...(sntp.status === 0 ? { HL_PROBE_CLOCK_OFFSET: sntp.stdout.trim().split("\n").at(-1) } : {}),
    ...(opts.runs ? { HL_PROBE_RUNS: opts.runs } : {}), ...(opts["close-runs"] ? { HL_PROBE_CLOSE_RUNS: opts["close-runs"] } : {}),
    ...(opts["pace-ms"] ? { HL_PROBE_PACE_MS: opts["pace-ms"] } : {}), ...(opts["fill-lag-min"] ? { HL_PROBE_FILL_LAG_MIN: opts["fill-lag-min"] } : {}),
    ...(opts.evidence === false ? { HL_PROBE_EVIDENCE: "0" } : {}), ...(opts["fill-lag"] === false ? { HL_PROBE_FILL_LAG: "0" } : {}) };
  const spec = ["--config", "./vitest.config.e2e.ts", "test/manual-mainnet-evidence-probe.e2e-spec.ts"];
  const [cmd, cmdArgs] = opts.runner ? [opts.runner, [root, ...spec]] : [process.execPath, [resolve(root, "scripts/test-api-isolated.mjs"), ...spec]];
  const code = await new Promise((done) => spawn(cmd, cmdArgs, { cwd: root, env, stdio: "inherit" }).once("exit", (c) => done(c ?? 1)));
  try { console.log(`\n${renderReport(JSON.parse(readFileSync(out, "utf8")))}\n\n${out}`); }
  catch { console.error(`no result at ${out}`); return code || 1; }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
