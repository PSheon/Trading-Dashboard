// Copy harness — the gate's measurements (gate run 9): distributions and
// counts read from the worker log, the local database and the workers'
// /health, recorded beside the checks and never pass/fail. They are what
// LIVE_HTTP_TIMEOUT_MS (20 s), CLOSE_ATTEMPT_LIMIT (30), MAX_LIVE_LEG_ATTEMPTS (3)
// and LIVE_LEG_RETRY_POLICY (3 s) get re-based on
// (docs/egress-subtraction-inventory-2026-10-15.md §2.3 item 3), and the rate-limit
// record of docs/design-hl-egress-2026-10-13.md §8 I-17.
//
// Pure (measure.test.mjs feeds fixtures): run.mjs gathers the log text, the
// database rows (measureSql, psql) and the /health bodies. Nothing here reads the
// network, the database or a secret; no row or log text it prints carries one.
import { createHash } from "node:crypto";
import { percentile } from "./lib.mjs";

/** n / p50 / p95 / p99 / max of finite numbers (nearest rank); nulls for no samples. */
export function distribution(values) {
  const xs = values.filter(Number.isFinite);
  return { n: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), p99: percentile(xs, 0.99), max: xs.length ? Math.max(...xs) : null };
}

// --- the worker log ----------------------------------------------------------------------------------

/** CopyLiveEngine: `leg <id> attempt <n> failed: <code>; elapsed <ms> ms, source age <ms> ms, exchange started <bool>`. */
const ATTEMPT_FAILED = /^leg (\S+) attempt (\d+) failed: ([a-z0-9_]+); elapsed (\d+) ms, source age (\d+) ms(?:, exchange started (true|false))?/;
/** CopyLiveEngine, right after a failed attempt that was a wait: `leg <id> budget unavailable: <reason>, retry <ms> ms`. */
const BUDGET_WAIT = /^leg (\S+) budget unavailable: ([a-z0-9_]+), retry (\d+) ms/;
/** CopyLiveEngine.afterUnsent: `leg <id>: attempt <n> released as never sent; planning attempt <n+1> of <max>`. */
const UNSENT_RELEASED = /^leg (\S+): attempt (\d+) released as never sent; planning attempt (\d+) of (\d+)/;
/** CopyLiveSetupService.logClaimWait: `setup <id> claim waits {setupId, need, waitMs, meter?}`. */
const CLAIM_WAIT = /^setup (\S+) claim waits (\{.*\})\s*$/;
/** HyperliquidLiveAccountObserver.expired: `live_account_evidence_expired {check, reason, ageMs, maxAgeMs}`. */
const EVIDENCE_EXPIRED = /^live_account_evidence_expired (\{.*\})\s*$/;
/** An HTTP 429 in a log line's text (Hyperliquid's budgeter and info client, Telegram, …). */
const HTTP_429 = /\b429\b/;
const HTTP_429_WORDING = /(\(429\)|429 from|status 429|HTTP 429|429 too many|rate.?limit)/i;

const timingOf = (timings, phase, stage) => timings.find((t) => t.phase === phase && t.stage === stage);

/**
 * Everything the measurements need from a slice of the worker log (JSON lines,
 * as stack.mjs writes them), within [since, until] (ms epoch):
 *   submits     each live_execution_timing's `executor_submit` mark (the transport's
 *               submit call: its pre-POST risk check plus the POST round trip);
 *   signers     per order, the `sign` phase: `signer_wallet_identity` → `signer_approval`
 *               (the wallet identity's check to the signing RPC's start: a lower bound of
 *               walletCheckedAt's age at signing) and `signer_rpc`;
 *   failures    failed leg attempts; budgetWaits, unsentReleases: the engine's lines beside them;
 *   claimWaits  setups' shared-meter claim waits (need, waitMs, meter composition);
 *   rate        foreign_usage_suspected, hl_ws_error_unmatched and HTTP 429 lines;
 *   walletCheckedAtLogged  whether any line in the window names walletCheckedAt;
 *   expired     the account observer's `live_account_evidence_expired {check, reason, ageMs, maxAgeMs}` lines.
 * @param {string} text @param {{ since?: number, until?: number }} [window]
 */
export function scanMeasureLog(text, { since = -Infinity, until = Infinity } = {}) {
  const out = { submits: [], signers: [], failures: [], budgetWaits: [], unsentReleases: [], claimWaits: [],
    rate: { foreignUsageSuspected: [], wsErrorUnmatched: [], http429: [] }, walletCheckedAtLogged: false, expired: [] };
  for (const line of text.split("\n")) {
    if (!line.includes("live_execution_timing") && !line.includes("leg ") && !line.includes("claim waits") && !line.includes("foreign_usage_suspected") &&
      !line.includes("hl_ws_error_unmatched") && !line.includes("429") && !line.includes("walletCheckedAt") && !line.includes("live_account_evidence_expired")) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.timestamp);
    if (!Number.isFinite(at) || at < since || at > until) continue;
    if (line.includes("walletCheckedAt")) out.walletCheckedAtLogged = true;
    const message = row.message;
    if (message && typeof message === "object" && message.event === "live_execution_timing" && Array.isArray(message.timings)) {
      const submit = timingOf(message.timings, "execute", "executor_submit");
      if (submit && submit.clockValid !== false) out.submits.push({ at: row.timestamp, ms: submit.elapsedMs });
      const identity = timingOf(message.timings, "sign", "signer_wallet_identity"), approval = timingOf(message.timings, "sign", "signer_approval");
      const rpc = timingOf(message.timings, "sign", "signer_rpc");
      if (identity && approval && identity.clockValid !== false && approval.clockValid !== false)
        out.signers.push({ at: row.timestamp, identityToRpcStartMs: approval.totalMs - identity.totalMs, rpcMs: rpc?.elapsedMs ?? null });
      continue;
    }
    if (typeof message !== "string") continue;
    let m;
    if ((m = message.match(ATTEMPT_FAILED)))
      out.failures.push({ at: row.timestamp, leg: m[1], attempt: Number(m[2]), reason: m[3], elapsedMs: Number(m[4]), sourceAgeMs: Number(m[5]), exchangeStarted: m[6] === undefined ? null : m[6] === "true" });
    else if ((m = message.match(BUDGET_WAIT))) out.budgetWaits.push({ at: row.timestamp, leg: m[1], reason: m[2], retryMs: Number(m[3]) });
    else if ((m = message.match(UNSENT_RELEASED))) out.unsentReleases.push({ at: row.timestamp, leg: m[1], attempt: Number(m[2]), next: Number(m[3]), of: Number(m[4]) });
    else if ((m = message.match(CLAIM_WAIT))) {
      let body = null;
      try { body = JSON.parse(m[2]); } catch { /* a truncated line */ }
      if (body) out.claimWaits.push({ at: row.timestamp, setupId: m[1], need: Number(body.need), waitMs: Number(body.waitMs), meter: body.meter ?? null });
    } else if (message.includes("foreign_usage_suspected")) {
      let body = null;
      try { body = JSON.parse(message.slice(message.indexOf("{"))); } catch { /* no body */ }
      out.rate.foreignUsageSuspected.push({ at: row.timestamp, status: body?.status ?? null, ourWindowUse: body?.ourWindowUse ?? null });
    } else if ((m = message.match(EVIDENCE_EXPIRED))) {
      let body = null;
      try { body = JSON.parse(m[1]); } catch { /* a truncated line */ }
      if (body) out.expired.push({ at: row.timestamp, check: String(body.check), reason: String(body.reason), ageMs: body.ageMs ?? null, maxAgeMs: body.maxAgeMs ?? null });
    } else if (message.includes("hl_ws_error_unmatched")) {
      let body = null;
      try { body = JSON.parse(message.slice(message.indexOf("{"))); } catch { /* no body */ }
      out.rate.wsErrorUnmatched.push({ at: row.timestamp, text: typeof body?.text === "string" ? body.text.slice(0, 200) : null });
    } else if (HTTP_429.test(message) && HTTP_429_WORDING.test(message)) {
      const context = String(row.context ?? "unknown");
      out.rate.http429.push({ at: row.timestamp, context, hyperliquid: /hyperliquid|requestbudget/i.test(context) || /hyperliquid/i.test(message) });
    }
  }
  return out;
}

/**
 * (d) The delay between a failed leg attempt and the leg's next try, per
 * failure code. The next try is the next failed attempt's start (its line's
 * time minus its `elapsed`), exact; or, after the leg's last failure, the
 * order's POST (the dispatch's sent_at: an upper bound, it includes the try's
 * preparation). `kind`: `budget_wait` when the engine logged `budget
 * unavailable` for that failure (a wait: never counted as an attempt), else
 * `attempt`. A wait's own `retry` is reported beside it.
 * @param {{ at: string, leg: string, reason: string, elapsedMs: number }[]} failures
 * @param {{ budgetWaits?: { at: string, leg: string, retryMs: number }[], dispatches?: { id: string, sentAt?: string | null }[] }} [more]
 */
export function attemptDelays(failures, { budgetWaits = [], dispatches = [] } = {}) {
  const byLeg = new Map();
  for (const f of failures) byLeg.set(f.leg, [...(byLeg.get(f.leg) ?? []), f]);
  const sentOf = new Map(dispatches.filter((d) => d.sentAt).map((d) => [d.id, Date.parse(d.sentAt)]));
  const samples = [];
  for (const [leg, list] of byLeg) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    list.forEach((f, i) => {
      const at = Date.parse(f.at);
      const wait = budgetWaits.find((b) => b.leg === leg && Math.abs(Date.parse(b.at) - at) <= 1000);
      const sample = { leg, reason: f.reason, kind: wait ? "budget_wait" : "attempt", retryMs: wait?.retryMs ?? null, nextMs: null, toSentMs: null };
      const next = list[i + 1];
      if (next) sample.nextMs = Date.parse(next.at) - next.elapsedMs - at;
      else if (sentOf.has(leg) && sentOf.get(leg) > at) sample.toSentMs = sentOf.get(leg) - at;
      samples.push(sample);
    });
  }
  const keys = [...new Set(samples.map((s) => `${s.reason}|${s.kind}`))].sort();
  const byReason = keys.map((key) => {
    const [reason, kind] = key.split("|"), xs = samples.filter((s) => s.reason === reason && s.kind === kind);
    return { reason, kind, failures: xs.length, legs: new Set(xs.map((s) => s.leg)).size, next: distribution(xs.map((s) => s.nextMs)), toSent: distribution(xs.map((s) => s.toSentMs)),
      retry: distribution(xs.map((s) => s.retryMs)) };
  });
  return { samples, byReason, next: distribution(samples.map((s) => s.nextMs)), toSent: distribution(samples.map((s) => s.toSentMs)) };
}

// --- the local database ------------------------------------------------------------------------------

/**
 * The cloid of one attempt of one leader leg. Mirrors
 * apps/api/src/copy/live/copy-live-leg-attempt.ts liveSourceExecutionCloid (read
 * only here, to tell which attempt suffixes a leg's journals used; measure.test.mjs
 * pins it to vectors computed from that file).
 */
export function legAttemptCloid(mandateId, sourceFillId, leg, attempt = 0) {
  const parts = ["live-copy-v1", mandateId, sourceFillId, leg, ...(attempt ? [attempt] : [])];
  return `0x${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}
/** The attempt suffixes a leg can use (MAX_LIVE_LEG_ATTEMPTS in copy-live-leg-attempt.ts). */
export const LEG_ATTEMPT_SUFFIXES = 3;

/**
 * One psql statement (-At: one JSON line) for the run's legs and journals:
 * `dispatches` (copy_live_dispatches of `strategyIds` created since `since`:
 * ids, leg, state, reason, counted attempts and the POST's sent/acked times)
 * and `cloids` (copy_live_executions of those strategies updated since then).
 * No key, signature, address or payload is selected.
 * @param {{ strategyIds: number[], since: string }} scope
 */
export function measureSql({ strategyIds, since }) {
  if (!strategyIds.length || !strategyIds.every(Number.isSafeInteger)) throw new Error("strategyIds: integers");
  if (!Number.isFinite(Date.parse(since))) throw new Error("since: an ISO time");
  const ids = strategyIds.join(","), from = `'${new Date(since).toISOString()}'`;
  return `select json_build_object(` +
    `'dispatches', (select coalesce(json_agg(t order by t."createdAt"), '[]'::json) from (select id, mandate_id as "mandateId", source_fill_id as "sourceFillId", leg, coin, state, reason, attempts, ` +
    `adjustment_id as "adjustmentId", execution_key is not null as "hasExecution", first_attempt_at as "firstAttemptAt", sent_at as "sentAt", acked_at as "ackedAt", settled_at as "settledAt", created_at as "createdAt" ` +
    `from copy_live_dispatches where strategy_id in (${ids}) and created_at >= ${from}) t), ` +
    `'cloids', (select coalesce(json_agg(lower(cloid)), '[]'::json) from copy_live_executions where strategy_id in (${ids}) and updated_at >= ${from}))`;
}

/**
 * (a) the exchange POST round trip per order (sent_at → acked_at of each
 * dispatch: the transport's request and response), and the orders whose POST
 * began with no answer recorded (a timeout or an ambiguous submission);
 * (b) the counted attempts of each close leg that settled (CLOSE_ATTEMPT_LIMIT
 * refuses a close at 30), and the closes that did not settle;
 * (c) per leg, the attempt suffixes its journals used (1–3, MAX_LIVE_LEG_ATTEMPTS)
 * and its counted attempts (budget waits excluded).
 * @param {{ id: string, mandateId: string, sourceFillId: string, leg: "open" | "close", state: string, reason: string | null, attempts: number, sentAt?: string | null, ackedAt?: string | null }[]} dispatches
 * @param {string[]} cloids the journals' cloids
 */
export function dispatchMeasures(dispatches, cloids) {
  const journals = new Set(cloids.map((c) => String(c).toLowerCase()));
  const post = dispatches.filter((d) => d.sentAt && d.ackedAt).map((d) => Date.parse(d.ackedAt) - Date.parse(d.sentAt));
  const unanswered = dispatches.filter((d) => d.sentAt && !d.ackedAt).length;
  const closes = dispatches.filter((d) => d.leg === "close");
  const settledCloses = closes.filter((d) => d.state === "settled");
  const otherCloses = {};
  for (const d of closes.filter((x) => x.state !== "settled")) {
    const k = `${d.state}:${d.reason ?? ""}`;
    otherCloses[k] = { count: (otherCloses[k]?.count ?? 0) + 1, maxAttempts: Math.max(otherCloses[k]?.maxAttempts ?? 0, d.attempts) };
  }
  const suffixes = [], histogram = {};
  for (const d of dispatches) {
    let used = 0;
    for (let a = 0; a < LEG_ATTEMPT_SUFFIXES; a++) if (journals.has(legAttemptCloid(d.mandateId, d.sourceFillId, d.leg, a))) used++;
    if (!used) continue;
    suffixes.push(used);
    histogram[used] = (histogram[used] ?? 0) + 1;
  }
  return {
    legs: dispatches.length,
    post: distribution(post), unanswered,
    closeAttempts: distribution(settledCloses.map((d) => d.attempts)), otherCloses,
    legSuffixes: { ...distribution(suffixes), histogram },
    legAttempts: distribution(dispatches.filter((d) => d.attempts > 0).map((d) => d.attempts)),
  };
}

// --- the workers' heartbeats (I-17) ------------------------------------------------------------------

/** What a worker's /health heartbeat says of rate limits and its egress (null fields: absent). */
export function heartbeatReading(url, body) {
  if (!body || typeof body !== "object") return { url, error: "no heartbeat body" };
  const fu = body.foreignUsage, egress = body.egressIdentity;
  return { url, role: body.worker?.role ?? null, rateLimited: Number.isFinite(fu?.rateLimited) ? fu.rateLimited : null, count: Number.isFinite(fu?.count) ? fu.count : null,
    lastStatus: fu?.lastStatus ?? null, egressMode: egress?.mode ?? "off (no egressIdentity)", publicIps: Array.isArray(egress?.publicIps) ? [...egress.publicIps].sort() : null };
}
/**
 * Start → end per worker: the counters' deltas (a counter lower at the end
 * means the process restarted: the end value then counts since its start),
 * the public IPs added and dropped, and IPs that two workers share at the end.
 */
export function heartbeatDeltas(start, end) {
  const rows = end.map((e) => {
    const s = start.find((x) => x.url === e.url);
    if (!s || s.error || e.error) return { url: e.url, error: s?.error ?? e.error ?? "no start reading" };
    const delta = (k) => (s[k] === null || e[k] === null ? null : e[k] >= s[k] ? e[k] - s[k] : e[k]);
    const restarted = ["rateLimited", "count"].some((k) => s[k] !== null && e[k] !== null && e[k] < s[k]);
    const before = new Set(s.publicIps ?? []), after = new Set(e.publicIps ?? []);
    return { url: e.url, role: e.role, rateLimited: delta("rateLimited"), count: delta("count"), restarted, start: { rateLimited: s.rateLimited, count: s.count }, end: { rateLimited: e.rateLimited, count: e.count },
      egressMode: e.egressMode, publicIps: e.publicIps, ipsAdded: [...after].filter((ip) => !before.has(ip)), ipsDropped: [...before].filter((ip) => !after.has(ip)) };
  });
  const owners = new Map();
  for (const e of end) for (const ip of e.publicIps ?? []) owners.set(ip, [...(owners.get(ip) ?? []), e.url]);
  return { rows, shared: [...owners].filter(([, urls]) => urls.length > 1).map(([ip, urls]) => ({ ip, urls })) };
}

/**
 * What the measured workers' roles (the heartbeats' worker.role, WORKER_ROLE) mean for the
 * local-bucket waits: an `all` worker's orders share the local bucket with TradeAnalytics / Cohort /
 * Leaderboard reads (gate 13's 18 s prepay wait was partly that artefact); a `copy` worker beside a
 * `read` worker is Stage's split. `urls`: the copy worker's url and the read worker's (null: none).
 * @param {{ url: string, role?: string | null, error?: string }[]} heartbeats
 * @param {{ copy: string, read: string | null }} urls
 */
export function workerRolesLabel(heartbeats, { copy, read }) {
  const of = (url) => heartbeats.find((h) => h.url === url);
  const copyRole = of(copy)?.role ?? null, readRole = read ? of(read)?.role ?? null : null;
  if (copyRole === "copy" && readRole === "read") return { split: true, copyRole, readRole, label: `roles split: copy worker ${copy}, read worker ${read} (as on Stage)` };
  if (copyRole === "all") return { split: false, copyRole, readRole, label: `all-role worker ${copy}: TradeAnalytics / Cohort / Leaderboard reads drain the same local bucket as the orders (roles not split; Stage splits them)` };
  return { split: false, copyRole, readRole, label: `worker ${copy} role ${copyRole ?? "unknown (no heartbeat role)"}${read ? `, read worker ${read} role ${readRole ?? "unknown"}` : ""}` };
}

// --- setup claims --------------------------------------------------------------------------------------

/** The step a setup runs at a stage (CopyLiveSetupSteps: funded → mode, mode_set → agent, agent_active → builder fee). */
export const SETUP_STEP_OF_STAGE = Object.freeze({ funded: "account_mode", mode_set: "agent", agent_active: "builder_fee" });
/**
 * The setups' claim waits per setup step: count, longest wait, and the meter's
 * composition at that longest wait. The step is the setup's last stage the
 * harness saw at or before the line (`timeline`: { setupId, at (ms), stage },
 * polled every few seconds), so it can lag a transition by one poll; a setup
 * the harness never polled is `unknown`.
 * @param {{ at: string, setupId: string, need: number, waitMs: number, meter: object | null }[]} claims
 * @param {{ setupId: string, at: number, stage: string }[]} timeline
 */
export function claimWaitSummary(claims, timeline = []) {
  const stageAt = (setupId, at) => timeline.filter((t) => t.setupId === setupId && t.at <= at).sort((a, b) => b.at - a.at)[0]?.stage ?? null;
  const groups = new Map();
  for (const c of claims) {
    const stage = stageAt(c.setupId, Date.parse(c.at)), step = stage ? (SETUP_STEP_OF_STAGE[stage] ?? `stage ${stage}`) : "unknown";
    const key = `${c.setupId}|${step}`;
    const g = groups.get(key) ?? { setupId: c.setupId, step, count: 0, needs: new Set(), longest: null };
    g.count++; g.needs.add(c.need);
    if (!g.longest || c.waitMs > g.longest.waitMs) g.longest = c;
    groups.set(key, g);
  }
  const rows = [...groups.values()].map((g) => ({ setupId: g.setupId, step: g.step, count: g.count, needs: [...g.needs], maxWaitMs: g.longest.waitMs, at: g.longest.at, meter: g.longest.meter }));
  const longest = claims.reduce((a, b) => (!a || b.waitMs > a.waitMs ? b : a), null);
  return { count: claims.length, maxWaitMs: longest?.waitMs ?? null, longest, rows };
}
/** One line for a meter composition (HyperliquidMeterComposition). */
export function formatMeter(meter) {
  if (!meter) return "no composition logged";
  const setup = Object.entries(meter.setup ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  const pending = (meter.pending ?? []).map((p) => `${p.token} need ${p.need} waiting ${p.waitingMs} ms`).join(", ");
  const granted = (meter.granted ?? []).map((g) => `${g.token} left ${g.left}`).join(", ");
  return `total ${meter.total}: background ${meter.background}, live ${meter.live}, page ${meter.page}, other ${meter.other}, setup {${setup}}, ` +
    `markers setup ${meter.markers?.setup ?? 0} / live ${meter.markers?.live ?? 0}, pending [${pending}], granted [${granted}], liveNeed ${meter.liveNeed}`;
}

// --- the summary's block ----------------------------------------------------------------------------------

const cell = (v) => (v === null || v === undefined ? "—" : String(Math.round(v))).padStart(7);
const distLine = (label, d, width = 52) => `  ${label.padEnd(width)} ${String(d.n).padStart(5)} ${cell(d.p50)} ${cell(d.p95)} ${cell(d.p99)} ${cell(d.max)}`;
const head = (unit, width = 52) => `  ${"".padEnd(width)} ${"n".padStart(5)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"p99".padStart(7)} ${"max".padStart(7)}  (${unit})`;

/**
 * The summary's measurements block. `m`: { window: {from, to}, log: scanMeasureLog | null,
 * logNote?, db: dispatchMeasures | null, dbNote?, delays: attemptDelays | null,
 * health: heartbeatDeltas | null, healthNote?, claims: claimWaitSummary | null,
 * roles?: workerRolesLabel (named beside the local-bucket waits of 1d) }.
 */
export function renderMeasurements(m) {
  const L = ["=".repeat(100), "MEASUREMENTS (recorded, not pass/fail; gate run 9: LIVE_HTTP_TIMEOUT_MS 20 s, CLOSE_ATTEMPT_LIMIT 30,",
    "MAX_LIVE_LEG_ATTEMPTS 3, LIVE_LEG_RETRY_POLICY 3 s; rate limits I-17)", `window ${m.window.from} → ${m.window.to}`, "=".repeat(100)];
  const log = m.log;
  L.push("", "1a. exchange POST round trip per order");
  L.push(head("ms"));
  if (m.db) L.push(distLine("sent_at → acked_at (copy_live_dispatches)", m.db.post), `  POST began, no answer recorded: ${m.db.unanswered} (LIVE_HTTP_TIMEOUT_MS 20 s; exchange_submission_ambiguous)`);
  else L.push(`  database: ${m.dbNote ?? "not read"}`);
  if (log) L.push(distLine("executor_submit mark (log; + pre-POST risk check)", distribution(log.submits.map((s) => s.ms))));
  L.push("", "1b. close attempts per close leg (counted attempts; CLOSE_ATTEMPT_LIMIT 30)");
  if (m.db) {
    L.push(head("attempts"), distLine("settled close legs", m.db.closeAttempts));
    const other = Object.entries(m.db.otherCloses);
    L.push(`  close legs not settled: ${other.length ? other.map(([k, v]) => `${k} ×${v.count} (max ${v.maxAttempts} attempts)`).join("; ") : "none"}`);
  } else L.push(`  database: ${m.dbNote ?? "not read"}`);
  L.push("", "1c. leg attempts per leg (MAX_LIVE_LEG_ATTEMPTS 3)");
  if (m.db) {
    L.push(head("per leg"), distLine("attempt suffixes used (journals of cloids 0..2)", m.db.legSuffixes), distLine("counted attempts (dispatch.attempts > 0)", m.db.legAttempts));
    L.push(`  suffixes used, legs: ${JSON.stringify(m.db.legSuffixes.histogram)}; legs in the run: ${m.db.legs}` +
      (log ? `; released as never sent: ${log.unsentReleases.length}` : ""));
  } else L.push(`  database: ${m.dbNote ?? "not read"}`);
  L.push("", "1d. failed leg attempt → the leg's next try, by failure code (LIVE_LEG_RETRY_POLICY 3 s)");
  if (m.roles) L.push(`  local-bucket waits measured on: ${m.roles.label}`);
  if (m.delays && m.delays.samples.length) {
    L.push(head("ms"));
    for (const r of m.delays.byReason) {
      L.push(`  ${r.reason} [${r.kind}]: ${r.failures} failure(s) on ${r.legs} leg(s)`);
      if (r.next.n) L.push(distLine("    → next failed attempt's start", r.next));
      if (r.toSent.n) L.push(distLine("    → order sent (sent_at; upper bound)", r.toSent));
      if (r.retry.n) L.push(distLine("    budget wait's own retry", r.retry));
    }
    L.push(distLine("all → next failed attempt's start", m.delays.next), distLine("all → order sent (upper bound)", m.delays.toSent));
  } else L.push(log ? "  no failed leg attempt in the window" : `  worker log: ${m.logNote ?? "not read"}`);
  L.push("", "1e. signer walletCheckedAt age at signing");
  if (log) {
    L.push(`  walletCheckedAt logged: ${log.walletCheckedAtLogged ? "yes (a line in the window names it)" : "NO — the worker never logs it (privy-order-signer.ts keeps it in memory only)"}`);
    L.push(head("ms"), distLine("lower bound: signer_wallet_identity → signer_approval", distribution(log.signers.map((s) => s.identityToRpcStartMs))),
      distLine("signer_rpc (the signing RPC itself)", distribution(log.signers.map((s) => s.rpcMs))));
    if (!log.walletCheckedAtLogged) L.push("  needs an api change to measure: log `now - walletCheckedAt` in assertRpcFresh (or as a timing/span of the",
      "  sign phase); the bound above misses the prefetch (prefetchWallet's checkedAt is taken when the read starts, before the sign phase).");
  } else L.push(`  worker log: ${m.logNote ?? "not read"}`);

  L.push("", "2. rate limits (I-17)");
  if (m.health) {
    for (const r of m.health.rows) {
      if (r.error) { L.push(`  ${r.url}: ${r.error}`); continue; }
      L.push(`  ${r.url} (${r.role ?? "role ?"}): foreignUsage rateLimited ${r.start.rateLimited} → ${r.end.rateLimited} (Δ ${r.rateLimited ?? "—"}), count ${r.start.count} → ${r.end.count} (Δ ${r.count ?? "—"})` +
        `${r.restarted ? " — counters went down: restarted, Δ counts since its start" : ""}`);
      L.push(`    egress ${r.egressMode}; publicIps ${r.publicIps ? r.publicIps.join(", ") || "none" : "—"}; added ${r.ipsAdded.join(", ") || "none"}; dropped ${r.ipsDropped.join(", ") || "none"}`);
    }
    L.push(`  publicIps shared between workers: ${m.health.shared.length ? m.health.shared.map((s) => `${s.ip} (${s.urls.join(", ")})`).join("; ") : "none"}`);
  } else L.push(`  heartbeats: ${m.healthNote ?? "not read"}`);
  if (log) {
    const r = log.rate, hl = r.http429.filter((x) => x.hyperliquid);
    const byContext = Object.entries(r.http429.reduce((acc, x) => ({ ...acc, [x.context]: (acc[x.context] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(", ");
    L.push(`  log lines in the window: foreign_usage_suspected ${r.foreignUsageSuspected.length}, hl_ws_error_unmatched ${r.wsErrorUnmatched.length}, ` +
      `HTTP 429 ${r.http429.length} (Hyperliquid ${hl.length}${byContext ? `; by context: ${byContext}` : ""})`);
    const texts = [...new Set(r.wsErrorUnmatched.map((x) => x.text).filter(Boolean))];
    for (const t of texts.slice(0, 5)) L.push(`    unmatched ws error: ${t.slice(0, 120)}`);
    const expired = Object.entries(log.expired.reduce((acc, x) => {
      const key = `${x.check} ${x.reason}`, prev = acc[key] ?? { count: 0, maxAgeMs: null };
      return { ...acc, [key]: { count: prev.count + 1, maxAgeMs: x.ageMs === null ? prev.maxAgeMs : Math.max(prev.maxAgeMs ?? -Infinity, x.ageMs) } };
    }, {}));
    L.push(`  live_account_evidence_expired: ${log.expired.length}${expired.length ? ` (${expired.map(([k, v]) => `${k} ×${v.count}, max age ${v.maxAgeMs ?? "—"} ms`).join("; ")})` : ""}`);
  }

  L.push("", "3. setup claim waits (shared meter)");
  if (m.claims && m.claims.count) {
    L.push(`  ${m.claims.count} claim wait line(s), longest ${m.claims.maxWaitMs} ms`);
    for (const r of m.claims.rows) L.push(`  setup ${r.setupId.slice(0, 8)} ${r.step.padEnd(12)} ${String(r.count).padStart(4)} line(s), need ${r.needs.join("/")}, longest ${r.maxWaitMs} ms at ${r.at}`);
    L.push(`  composition at the longest wait (setup ${m.claims.longest.setupId.slice(0, 8)}, need ${m.claims.longest.need}): ${formatMeter(m.claims.longest.meter)}`);
  } else L.push(log ? "  no claim wait line in the window" : `  worker log: ${m.logNote ?? "not read"}`);
  L.push("=".repeat(100));
  return L.join("\n");
}
