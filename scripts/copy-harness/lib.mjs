// Copy harness — pure helpers shared by run.mjs (unit-tested in harness.test.mjs).
// Nothing here touches the network, the database or a secret.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const ADDRESS = /^0x[0-9a-f]{40}$/;
export const HARNESS_LEADER = "0xb56719305c461afd0de51b9e5b7146fe045553e1";

/** The run's terms (spec §1): 150 sent, a 100 budget, 12 per trade, 10 withdrawn. */
export const TERMS = Object.freeze({ sendUsd: 150, budgetUsd: 100, perTradeUsd: 12, withdrawUsd: 10, leaderScenarioUsd: 20 });

/** `KEY=value` lines (quotes stripped, comments and blanks skipped). Values stay in memory; never print them. */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
export const loadEnv = (path = resolve(ROOT, ".env")) => parseEnv(readFileSync(path, "utf8"));

/** Sending is needed only while the follower's main wallet can't cover the
 * budget; the leader then sends up to `sendUsd`, at least the shortfall
 * (whole USDC, plus 1), and keeps room for its scenario (none when the copy
 * follows a real trader). Too little on either side stops the run before
 * anything is signed. */
export function fundingGate({ leader, follower, terms = TERMS }) {
  const send = follower < terms.budgetUsd;
  const minimumSend = send ? Math.ceil(terms.budgetUsd - follower) + 1 : 0;
  const leaderNeeds = terms.leaderScenarioUsd + minimumSend;
  const sendUsd = send ? Math.min(terms.sendUsd, Math.floor(leader - terms.leaderScenarioUsd)) : 0;
  const problems = [];
  if (leader < leaderNeeds) {
    problems.push(`the harness leader ${HARNESS_LEADER} holds ${leader.toFixed(2)} testnet USDC and needs at least ${leaderNeeds.toFixed(2)}` +
      (send ? ` (${minimumSend} for the follower, ${terms.leaderScenarioUsd} for its scenario)` : ` (for its scenario)`));
    if (send) problems.push(`the follower's main wallet holds ${follower.toFixed(2)} testnet USDC, under the ${terms.budgetUsd} USDC budget, and the leader can't top it up`);
  }
  return { ok: problems.length === 0, send, sendUsd, leaderNeeds, problems };
}

/** Nearest-rank percentile, two decimals; null for no samples. */
export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return Number(xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))].toFixed(2));
}

const RUNNING = new Set(["starting", "active", "paused"]);
const UNFINISHED_SETUP = new Set(["provisioning", "awaiting_consent"]);
const ENDED_SETUP = new Set(["failed", "expired"]);
/**
 * What must happen before a fresh copy of `leader` can start (idempotent
 * rerun): copies of the leader that run are stopped, setups that wait for a
 * consent (or ended without finishing) are cancelled, and stops in progress
 * are waited for. Copies of other leaders are left alone (the Privy test
 * account is shared with other checks).
 */
export function planCleanup(items, leader = HARNESS_LEADER) {
  const actions = [];
  for (const item of items) {
    if (item.leaderAddress !== leader) continue;
    const setup = item.setup ?? null;
    if (setup && (UNFINISHED_SETUP.has(setup.stage) || ENDED_SETUP.has(setup.stage))) actions.push({ kind: "cancel_setup", strategyId: item.strategyId, setupId: setup.id });
    else if (RUNNING.has(item.stage) && item.mandate) actions.push({ kind: "stop", strategyId: item.strategyId, mandateId: item.mandate.id, revision: item.mandate.revision, accountId: item.accountId });
    // A start that ended without a generation leaves its arrived funds for the
    // owner to return (copy-live-portfolio.repository): stage sweeping with no
    // sweep or transfer moving. The harness returns them as the owner would;
    // waiting would never settle (gate 11 run 4, 2026-10-16).
    else if (item.stage === "sweeping" && !item.sweep && !item.pendingTransfer && item.accountId) actions.push({ kind: "return_all", strategyId: item.strategyId, accountId: item.accountId });
    else if (item.stage === "stopping" || item.stage === "sweeping") actions.push({ kind: "await_stop", strategyId: item.strategyId, accountId: item.accountId });
    else if (setup && ["consented", "funding_submitted", "funded", "mode_set", "agent_active", "builder_ready"].includes(setup.stage)) actions.push({ kind: "await_setup", strategyId: item.strategyId, setupId: setup.id });
  }
  return actions;
}

/** A portfolio item settles once its stop is done and its return is no longer moving. */
export function stopSettled(item) {
  return item?.stage === "stopped" && (!item.sweep || ["credited", "rejected", "cancelled"].includes(item.sweep.status)) && !item.pendingTransfer;
}

/** One line per check, then the latency block; `ok` is null for a check that was skipped. */
export function renderSummary({ checks, latency = null, weightPerOrder = null, mode = "full" }) {
  const width = Math.max(5, ...checks.map((c) => c.name.length));
  const mark = (ok) => ok === true ? "PASS" : ok === false ? "FAIL" : "SKIP";
  const lines = [`copy harness (${mode}) — ${new Date().toISOString()}`, `${"check".padEnd(width)}  result  detail`, `${"-".repeat(width)}  ------  ------`];
  for (const c of checks) lines.push(`${c.name.padEnd(width)}  ${mark(c.ok).padEnd(6)}  ${c.detail ?? ""}`);
  if (latency) {
    const width = Math.max(35, ...Object.keys(latency).map((k) => k.length));
    lines.push("", `${"latency (s; from the leader's fill unless named)".padEnd(width + 2)}     p50     p95     max`);
    for (const [name, v] of Object.entries(latency)) lines.push(`  ${name.padEnd(width)} ${fmt(v?.p50)} ${fmt(v?.p95)} ${fmt(v?.max)}`);
  }
  lines.push(`weight per order: ${weightPerOrder ?? "n/a"}`);
  const failed = checks.filter((c) => c.ok === false).length;
  lines.push("", failed ? `${failed} check(s) FAILED` : "ALL GREEN");
  return lines.join("\n");
}
const fmt = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(2)).padStart(7);

/** Exit codes: 0 green, 1 a check failed, 2 usage, 3 not funded (nothing was signed or sent). */
export const EXIT = Object.freeze({ green: 0, failed: 1, usage: 2, unfunded: 3 });

/**
 * Polls `read` until `done(value)` or the deadline; returns the last value and whether it finished.
 * @template T
 * @param {() => Promise<T>} read @param {(value: T) => boolean} done
 * @param {{ timeoutMs: number, intervalMs?: number, onTick?: (value: T) => void }} options
 * @returns {Promise<{ value: T, ok: boolean }>}
 */
export async function waitFor(read, done, { timeoutMs, intervalMs = 2000, onTick }) {
  const end = Date.now() + timeoutMs;
  let value;
  for (;;) {
    value = await read();
    onTick?.(value);
    if (done(value)) return { value, ok: true };
    if (Date.now() >= end) return { value, ok: false };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// --- profiles and scenarios ---------------------------------------------------------------------

/** Each stack profile's files (this directory), layered in order over harness.env (stack.mjs). */
export const PROFILE_FILES = Object.freeze({ "stage-caps": ["stage-caps.env"], "ratio-floor": ["ratio-floor.env"], "stage-like": ["ratio-floor.env", "stage-like.env"] });
/** The variables a profile gives the api and the worker (harness.env, then its files). No secrets live in them. */
export function profileEnv(profile = "default") {
  const files = ["harness.env", ...(profile === "default" ? [] : PROFILE_FILES[profile] ?? [])];
  if (profile !== "default" && !PROFILE_FILES[profile]) throw new Error(`unknown profile ${profile} (${Object.keys(PROFILE_FILES).join(" | ")})`);
  return Object.assign({}, ...files.map((f) => parseEnv(readFileSync(resolve(import.meta.dirname, f), "utf8"))));
}

/** The database round trip (ms) the worker's latest start runs with, from its
 * log: db-rtt.preload.mjs prints `copy_harness_db_rtt` just before Nest starts.
 * 0: started without one; null: no start in the text. */
export function lastStartRtt(text) {
  let pending = null, current = null;
  for (const line of text.split("\n")) {
    if (line.includes('"event":"copy_harness_db_rtt"')) { try { pending = Number(JSON.parse(line).ms); } catch { /* not ours */ } }
    else if (line.includes("Starting Nest application")) { current = pending ?? 0; pending = null; }
  }
  return current;
}

/** The run's terms per stack profile: `default` (harness.env) or `stage-caps`
 * (stage-caps.env over it: Stage's caps, 12–15 per trade, 50 per copy, leverage 3). */
export function termsFor(profile = "default") {
  if (profile === "default") return { ...TERMS, maxPerTradeUsd: TERMS.perTradeUsd, maxLeverage: 3, profile };
  if (profile === "stage-caps") return { ...TERMS, budgetUsd: 50, maxPerTradeUsd: 15, maxLeverage: 3, profile };
  // The planned mainnet functional test: ratio sizing with the TEST ONLY minimum floor (ratio-floor.env).
  if (profile === "ratio-floor") return { ...TERMS, budgetUsd: 50, sizingMode: "ratio", ratioFloorMaxUsd: 15, maxPerTradeUsd: 15, maxLeverage: 3, profile };
  // The pre-mainnet gate: ratio-floor with Stage's 8 ms database round trip (stage-like.env).
  if (profile === "stage-like") return { ...termsFor("ratio-floor"), profile };
  throw new Error(`unknown profile ${profile} (default | stage-caps | ratio-floor | stage-like)`);
}

/**
 * The scenarios run.mjs can run (`--scenarios a,b,c`, by name or number).
 * `endsCopy`: it stops the copy, so the next scenario starts a new one.
 */
export const SCENARIOS = Object.freeze({
  base: { no: "1", endsCopy: true, about: "open, add, reduce half, close, short, flip, close; withdraw 10; stop with the return credited" },
  "reduce-min": { no: "3", endsCopy: false, about: "reduce 25 % of a 48 USD leader position (follower reduction under 10 USD), then a full close" },
  "stop-open": { no: "4", endsCopy: true, about: "stop while a position is open: closed flat, the return credited, shown stopped" },
  "close-then-stop": { no: "6", endsCopy: true, about: "the owner's single-position close, then a stop within 2 s: flat and stopped, never blocked" },
  "worker-restart": { no: "7", endsCopy: false, about: "the worker restarts between a leader trade and its fill: no double send, later legs trade" },
  "refused-open": { no: "8", endsCopy: false, about: "an open refused under the order minimum (below_min_notional), then later legs, a close included, execute" },
  burst: { no: "9", endsCopy: false, about: "the leader closes in 3 fills within 20 s; the follower ends flat" },
  "kill-switch": { no: "14", endsCopy: true, about: "platform pause (opens refused, reductions mirrored), then admin close-all closes and returns" },
  follow: { no: "20", endsCopy: true, about: "follow --leader (a real mainnet trader) for --watch-min minutes: every leg settled or refused for an expected reason, then stop" },
  // The pre-mainnet gate's legs (2026-10-12: a second coin's open refused live_generation_unproven).
  "new-coin": { no: "21", endsCopy: false, about: "open BTC, settled; then a first open of ETH, then of SOL, each settled; then close all three" },
  "add-reduce": { no: "22", endsCopy: false, about: "open ETH, add (same coin), partial reduce (half), full close: each its own order" },
  merged: { no: "23", endsCopy: false, about: "three ETH opens 3 s apart, then three reductions 3 s apart ending flat: legs merged within the window, follower flat" },
  flip: { no: "24", endsCopy: false, about: "open ETH long, then flip to short in ONE fill (a close and an open leg), then close" },
});
/** `--scenarios gate`: every leg type, in order, on a fresh copy (new-coin
 * first, so its coins are the copy's first), ending with a stop and its return. */
export const GATE_SCENARIOS = Object.freeze(["new-coin", "add-reduce", "merged", "flip", "stop-open"]);
/** `--scenarios` → scenario names, in the given order (default: base; `gate` expands to GATE_SCENARIOS). */
export function parseScenarios(value) {
  if (!value) return ["base"];
  const names = value.split(",").map((s) => s.trim()).filter(Boolean).flatMap((s) => s === "gate" ? GATE_SCENARIOS : [s]).map((s) => {
    const name = SCENARIOS[s] ? s : Object.entries(SCENARIOS).find(([, v]) => v.no === s)?.[0];
    if (!name) throw new Error(`unknown scenario ${s} (${Object.entries(SCENARIOS).map(([k, v]) => `${v.no}=${k}`).join(", ")})`);
    return name;
  });
  return [...new Set(names)];
}

/** Scenario 8's selected market, or null when the deployment caps leave none. */
export function refusableMarket(markets, terms, fixedOrderSize) {
  const pick = refusableCoin(markets, terms, fixedOrderSize);
  return pick ? { coin: pick.name, szDecimals: pick.szDecimals, mid: pick.mid, lotUsd: pick.mid / 10 ** pick.szDecimals, terms } : null;
}

/**
 * A perp whose fixed amount can't be sent (scenario 8): per-trade USD at the
 * coin's lot size falls under the exchange minimum, and the minimum's
 * round-up exceeds the per-trade maximum, with 3 % of price room either way.
 * `markets`: [{ name, szDecimals, mid, delisted }]. Null when none fits.
 */
export function refusableCoin(markets, { perTradeUsd, maxPerTradeUsd, minOrderUsd = 10 }, fixedOrderSize) {
  const fits = (m) => [0.97, 1, 1.03].every((k) => fixedOrderSize({ perTradeUsd, maxPerTradeUsd, minOrderUsd }, m.mid * k, m.szDecimals) === null);
  const candidates = markets.filter((m) => !m.delisted && m.mid > 0 && !m.name.includes(":") && fits(m));
  // The cheapest lot keeps the leader's own order small.
  return candidates.sort((a, b) => a.mid / 10 ** a.szDecimals - b.mid / 10 ** b.szDecimals)[0] ?? null;
}

// --- the worker's order timings (pre-mainnet gate) ---------------------------------------------------

/** An order's evidence must stay well inside the 5 s window (live_risk_stale) — the gate's limit. */
export const EVIDENCE_MAX_MS = 3500;
/** The api's evidence window on mainnet (LIVE_EVIDENCE_MAX_AGE_MS; read-only copy). */
export const MAINNET_EVIDENCE_WINDOW_MS = 5000;
/** The evidence window a profile runs the api and the worker with: COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS
 * (testnet only; stage-like: 7000), else mainnet's 5000. */
export function evidenceWindowMs(env = {}) {
  const raw = env.COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS;
  if (raw === undefined || raw === "") return MAINNET_EVIDENCE_WINDOW_MS;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < MAINNET_EVIDENCE_WINDOW_MS) throw new Error(`COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS: ${raw} is not a window`);
  return ms;
}
/** Which window an evidence figure was measured under: a wider one is never mainnet-equivalent. */
export function evidenceWindowLabel(ms = MAINNET_EVIDENCE_WINDOW_MS) {
  return ms === MAINNET_EVIDENCE_WINDOW_MS ? `evidence window ${ms} ms (mainnet's)`
    : `evidence window ${ms} ms (TESTNET allowance, not mainnet-equivalent; mainnet stays ${MAINNET_EVIDENCE_WINDOW_MS})`;
}
/** Attempt failures that mean the evidence or its generation proof could not be held: the gate fails on any. */
export const EVIDENCE_FAILURES = Object.freeze(["live_risk_stale", "live_risk_serialization_stale", "market_evidence_expired",
  "live_risk_generation_unproven", "live_generation_unproven", "live_preparation_generation_changed", "live_read_deadline_exceeded"]);

/**
 * One order from a worker `live_execution_timing` line (LiveExecutionRuntime):
 * its phases' timings, in the order they were marked. The runtime's own
 * `execute` mark runs from the preparation's start (where the evidence window
 * opens) through `runtime_hold`; the executor's `execute` mark starts right
 * after and reaches `executor_submit_gate`, the last evidence check before the
 * exchange. `evidenceMs` is the two together: what the 5 s window has to hold.
 * `orderMs` adds the exchange call (`executor_submit`). `phases`: the longest
 * total of each phase (prepare, collect, hold, sign, submit, execute).
 * `network`: the execution network the timings name (testnet | mainnet; null: none).
 * Null for a line that is not an order's preparation (a recovery's reconcile).
 * @param {{ phase: string, stage: string, elapsedMs: number, totalMs: number }[]} timings
 */
export function orderEvidence(timings) {
  if (!Array.isArray(timings)) return null;
  const stage = (name) => timings.find((t) => t.phase === "execute" && t.stage === name);
  const prepared = stage("runtime_prepare");
  if (!prepared) return null;
  const runtime = (stage("runtime_hold") ?? prepared).totalMs;
  const executor = timings.filter((t) => t.phase === "execute" && t.stage.startsWith("executor_"));
  const gate = stage("executor_submit_gate") ?? executor.filter((t) => t.stage !== "executor_submit").at(-1);
  const submit = stage("executor_submit");
  /** @type {Record<string, number>} */
  const phases = {};
  for (const t of timings) phases[t.phase] = Math.max(phases[t.phase] ?? 0, t.totalMs);
  const network = timings.find((t) => typeof t.network === "string")?.network ?? null;
  return { network, evidenceMs: runtime + (gate?.totalMs ?? 0), orderMs: runtime + (submit?.totalMs ?? gate?.totalMs ?? 0), submitted: Boolean(submit), phases };
}

/** `leg <id> attempt <n> failed: <reason>; elapsed <ms> ms, source age <ms> ms, …` (CopyLiveEngine). */
const ATTEMPT_FAILED = /^leg (\S+) attempt (\d+) failed: ([a-z0-9_]+); elapsed (\d+) ms, source age (\d+) ms/;
/** `leg <id> refused: <reason> (source age <ms> ms, <n> attempt(s), last <code>)` (CopyLiveEngine.submit: an
 * open lost for good to signal age after its attempts failed; `last` is the final attempt's failure code). */
const LEG_REFUSED = /^leg (\S+) refused: ([a-z0-9_]+)(?: \(source age (\d+) ms, (\d+) attempt\(s\), last ([a-z0-9_]+)\))?/;

/**
 * The orders, failed attempts, boundary failures and refused legs in a slice of the
 * worker's log (JSON lines, as stack.mjs writes them), within [since, until] when
 * given (ms epoch). `refusals`: legs the engine gave up on (`leg … refused: …`), with
 * the last attempt's failure code when the line names it.
 * @param {string} text @param {{ since?: number, until?: number }} [window]
 */
export function scanWorkerLog(text, { since = -Infinity, until = Infinity } = {}) {
  const orders = [], failures = [], boundary = [], refusals = [];
  for (const line of text.split("\n")) {
    if (!line.includes("live_execution_timing") && !line.includes(" failed: ") && !line.includes(" refused: ") && !line.includes("live_execution_boundary_failure")) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.timestamp);
    if (!Number.isFinite(at) || at < since || at > until) continue;
    const message = row.message;
    if (message && typeof message === "object" && message.event === "live_execution_timing") {
      const order = orderEvidence(message.timings);
      if (order) orders.push({ at: row.timestamp, ...order, spans: Array.isArray(message.spans) ? message.spans : [] });
    } else if (message && typeof message === "object" && message.event === "live_execution_boundary_failure") {
      boundary.push({ at: row.timestamp, stage: message.stage, errorCode: message.errorCode, ...(message.budgetReason ? { budgetReason: message.budgetReason } : {}) });
    } else if (typeof message === "string") {
      let m;
      if ((m = message.match(ATTEMPT_FAILED))) failures.push({ at: row.timestamp, leg: m[1], attempt: Number(m[2]), reason: m[3], elapsedMs: Number(m[4]), sourceAgeMs: Number(m[5]) });
      else if ((m = message.match(LEG_REFUSED))) refusals.push({ at: row.timestamp, leg: m[1], reason: m[2], sourceAgeMs: m[3] === undefined ? null : Number(m[3]), attempts: m[4] === undefined ? null : Number(m[4]), last: m[5] ?? null });
    }
  }
  return { orders, failures, boundary, refusals };
}

/** An order's spans (LiveSpanRecorder.summary) summed per role: follower, leader, target, other_account, and `none` (unlabelled). */
export function spansByRole(order) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const s of order.spans ?? []) { const role = String(s.span).split(":")[1] ?? "none"; out[role] = (out[role] ?? 0) + (Number(s.totalMs) || 0); }
  return out;
}
/** Per span (name:role) over the orders: in how many it occurs and p50/p95/max of its total per order, slowest p95 first. */
export function spanStats(orders) {
  const per = new Map();
  for (const o of orders) for (const s of o.spans ?? []) per.set(s.span, [...(per.get(s.span) ?? []), Number(s.totalMs) || 0]);
  return [...per].map(([span, xs]) => ({ span, orders: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: Math.max(...xs) }))
    .sort((a, b) => b.p95 - a.p95 || a.span.localeCompare(b.span));
}
/** The spans block of the summary: each order's evidence and its spans per role, then each span's p50/p95/max. */
export function renderSpans(rows) {
  const lines = ["evidence spans per order (ms; per role: follower / leader / target / other_account / none)"];
  for (const r of rows) for (const o of r.orders ?? []) {
    const roles = spansByRole(o);
    lines.push(`  ${r.name.padEnd(10)} ${o.at}  evidence ${String(o.evidenceMs).padStart(5)}  ` + ["follower", "leader", "target", "other_account", "none"].map((k) => `${k} ${roles[k] ?? 0}`).join(", "));
  }
  const stats = spanStats(rows.flatMap((r) => r.orders ?? []));
  if (stats.length) {
    const width = Math.max(4, ...stats.map((s) => s.span.length));
    lines.push("", `${"span".padEnd(width)}  orders     p50    p95    max  (ms per order)`);
    for (const s of stats) lines.push(`${s.span.padEnd(width)}  ${String(s.orders).padStart(6)}  ${[s.p50, s.p95, s.max].map((v) => String(Math.round(v)).padStart(6)).join(" ")}`);
  }
  return lines.join("\n");
}

/** Codes a real leader's follow must never show (2026-10-12), in the worker's attempts and boundary failures and in the dispatches. */
export const FOLLOW_ZERO_CODES = Object.freeze(["live_risk_stale", "hyperliquid_busy", "live_generation_unproven", "live_risk_generation_unproven"]);
/**
 * How often each code appears: failed attempts and boundary failures (the
 * worker log) and the dispatches' final reasons (`state:reason` → count, as
 * run.mjs legOutcomes gives them).
 */
export function zeroCodeCounts({ failures = [], boundary = [], outcomes = {} }, codes = FOLLOW_ZERO_CODES) {
  return Object.fromEntries(codes.map((code) => [code, {
    attempts: failures.filter((f) => f.reason === code).length,
    boundary: boundary.filter((b) => b.errorCode === code).length,
    dispatches: Object.entries(outcomes).filter(([k]) => k.split(":")[1] === code).reduce((sum, [, n]) => sum + n, 0),
  }]));
}

// --- legs in flight (gate 13: a scenario judged while an attempt still ran) ------------------------------------

/** The risk policy's default maxSignalAgeSeconds (packages/shared copy.ts copyRiskLimitsSchema; read-only copy):
 * the age past which the engine refuses an open as signal_expired, so no attempt of it can start later. */
export const DEFAULT_SIGNAL_AGE_LIMIT_MS = 120_000;
/** Margin past the signal-age limit for a close (which never ages) or a last attempt that started just inside it. */
export const IN_FLIGHT_WAIT_MARGIN_MS = 30_000;
/** The longest the harness waits for in-flight legs before it judges or stops, whatever the limit says. */
export const IN_FLIGHT_WAIT_MAX_MS = 150_000;
/** How long to wait for in-flight legs: the signal-age limit plus the margin, at most IN_FLIGHT_WAIT_MAX_MS. */
export function inFlightWaitMs(signalAgeLimitMs = DEFAULT_SIGNAL_AGE_LIMIT_MS) {
  const limit = Number.isFinite(signalAgeLimitMs) && signalAgeLimitMs > 0 ? signalAgeLimitMs : DEFAULT_SIGNAL_AGE_LIMIT_MS;
  return Math.min(IN_FLIGHT_WAIT_MAX_MS, limit + IN_FLIGHT_WAIT_MARGIN_MS);
}
/**
 * One psql statement (-At: one JSON line, `[]` for none) for the copies' legs that are not terminal:
 * copy_live_dispatches of `strategyIds` in state pending or submitted, with what tells an attempt in
 * flight or a retry due (attempts, reason, first_attempt_at; the table has no next-attempt column: a
 * pending leg with a reason or a counted attempt is one the engine retries, LIVE_LEG_RETRY_BASE_MS).
 * No key, address or payload is selected.
 */
export function inFlightSql(strategyIds) {
  if (!strategyIds.length || !strategyIds.every(Number.isSafeInteger)) throw new Error("strategyIds: integers");
  return `select coalesce(json_agg(t), '[]'::json) from (select id, leg, coin, state, reason, attempts, first_attempt_at as "firstAttemptAt", ` +
    `updated_at as "updatedAt" from copy_live_dispatches where strategy_id in (${strategyIds.join(",")}) and state in ('pending', 'submitted') order by created_at) t`;
}
/**
 * The legs still in flight among the rows inFlightSql returns: a `submitted` order (sent, not yet
 * resolved), or a `pending` leg with a running attempt (first_attempt_at set) or a retry due (a
 * counted attempt or a reason, the engine's retry marker). A pending leg nobody has attempted yet
 * (no first attempt, no reason, no attempt counted) only waits for the next engine pass, or to
 * merge: not in flight. Terminal rows (settled, refused) never are.
 * @param {{ id: string, leg: string, coin: string, state: string, reason?: string | null, attempts?: number, firstAttemptAt?: string | null }[]} rows
 */
export function inFlightDispatches(rows) {
  return rows.filter((r) => r.state === "submitted" || (r.state === "pending" && (Boolean(r.firstAttemptAt) || Number(r.attempts) > 0 || Boolean(r.reason))))
    .map((r) => ({ id: r.id, leg: r.leg, coin: r.coin, state: r.state, reason: r.reason || null, attempts: Number(r.attempts) || 0, firstAttemptAt: r.firstAttemptAt ?? null }));
}
/**
 * Waits while `read()` (the rows of inFlightSql) shows a leg in flight, polling every `intervalMs`
 * until none is or `waitMs` has passed. Nothing in flight at the first read: returns at once, no
 * sleep. Returns the legs seen at the first read, those still in flight at the end (`[]`: all
 * settled or refused), how long it waited and whether it gave up (`timedOut`).
 * @param {() => Promise<object[]>} read
 * @param {{ waitMs: number, intervalMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} options
 */
export async function waitForInFlight(read, { waitMs, intervalMs = 3000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const start = now(), end = start + waitMs;
  const first = inFlightDispatches(await read());
  let left = first, polls = 1;
  while (left.length && now() < end) {
    await sleep(Math.max(0, Math.min(intervalMs, end - now())));
    left = inFlightDispatches(await read());
    polls++;
  }
  return { dispatches: first, left, waitedMs: now() - start, polls, timedOut: left.length > 0 };
}

// --- stuck rows (a manual stuck detector) --------------------------------------------------------------------

/** How long a row with an issue may wait past its retry before it counts as stuck. */
export const STUCK_AFTER_MS = 120_000;
/**
 * One query (psql -At, `|` separated: table|id|issue|state|waiting since) for
 * the operations that stopped moving: a row with an issue (or, for funding,
 * which has no issue column, any row) in a non-final state whose retry time —
 * copy_live_setups.next_attempt_at; the other tables have none, so updated_at
 * — is over 2 minutes past. `userId`/`since` narrow it to one user's rows
 * created since then (a run's own); omit them for the whole database.
 * @param {{ userId?: number | null, since?: string | null, stuckAfterMs?: number }} [scope]
 */
export function stuckRowsSql({ userId = null, since = null, stuckAfterMs = STUCK_AFTER_MS } = {}) {
  if (userId !== null && !Number.isSafeInteger(userId)) throw new Error("userId: an integer");
  if (since !== null && !Number.isFinite(Date.parse(since))) throw new Error("since: an ISO time");
  const scope = `${userId === null ? "" : ` and user_id = ${userId}`}${since === null ? "" : ` and created_at >= '${new Date(since).toISOString()}'`}`;
  const cutoff = `now() - interval '${Math.round(stuckAfterMs / 1000)} seconds'`;
  return [
    `select 'copy_live_setups', id, issue, stage, next_attempt_at from copy_live_setups where issue is not null and stage not in ('running', 'cancelled', 'failed', 'expired') and next_attempt_at < ${cutoff}${scope}`,
    `select 'copy_live_stop_operations', id, issue, state, updated_at from copy_live_stop_operations where issue is not null and state <> 'stopped' and updated_at < ${cutoff}${scope}`,
    `select 'copy_funding_operations', id, null, status, updated_at from copy_funding_operations where status not in ('credited', 'rejected', 'cancelled') and updated_at < ${cutoff}${scope}`,
    // An unattempted operation whose setup ended (cancelled, failed, expired) is that setup's leftover, not a stuck
    // operation: nothing retries it and no consent will come (gate 13: f0dbea7b, prepared/account_mode_not_submitted
    // under a cancelled setup, flagged on every run since gate 11).
    `select 'copy_account_mode_operations', id, issue, submission_state || '/' || target_state, updated_at from copy_account_mode_operations where issue is not null and target_state not in ('supported', 'unsupported') and not (attempted_at is null and exists (select 1 from copy_live_setups s where s.id = copy_account_mode_operations.live_setup_id and s.stage in ('cancelled', 'failed', 'expired'))) and updated_at < ${cutoff}${scope}`,
  ].join(" union all ") + " order by 1, 2";
}
/** psql -At output of stuckRowsSql → rows. */
export function parseStuckRows(text) {
  return text.split("\n").filter((l) => l.trim()).map((l) => { const [table, id, issue, state, since] = l.split("|"); return { table, id, issue: issue || null, state, since }; });
}

/** p50/p95/max of the orders' evidence (ms), and how many reached `maxMs`. */
export function evidenceStats(orders, maxMs = EVIDENCE_MAX_MS) {
  const xs = orders.map((o) => o.evidenceMs);
  return { orders: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: xs.length ? Math.max(...xs) : null, over: xs.filter((x) => x >= maxMs).length };
}

/**
 * The gate's table: one line per scenario, pass/fail and its orders' judged evidence p50/p95/max (ms),
 * then the raw max, the mainnet projection's max and the evidence window in force; then the two
 * classes of a failure (criteria.mjs classifyScenario) — `miss`: a criterion miss (an order's judged
 * evidence at or over the limit with no money effect), `trip`: trip-wire hits (legs lost to evidence
 * age) — and the copy's own signal latency, dispatch created → order sent (s, p50); then all of them
 * (`miss`: scenarios with a miss; `trip`: hits summed; `sent`: the scenarios' largest max). Judged:
 * `judgedMs` (a testnet order without its dex fan-out, criteria.mjs), else the raw `evidenceMs`.
 * @param {{ name: string, ok: boolean | null, orders?: object[], criterionMiss?: boolean, tripWire?: { hits: number } | null, createdToSent?: { p50: number | null, max: number | null } | null }[]} rows
 */
export function renderGateSummary(rows, maxMs = EVIDENCE_MAX_MS, windowMs = MAINNET_EVIDENCE_WINDOW_MS) {
  const width = Math.max(8, ...rows.map((r) => r.name.length));
  const ms = (v) => (v === null || v === undefined ? "—" : String(Math.round(v))).padStart(6);
  const s2 = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(2)).padStart(6);
  const count = (v) => (v === null || v === undefined ? "—" : String(v)).padStart(5);
  const mark = (ok) => ok === true ? "PASS" : ok === false ? "FAIL" : "SKIP";
  const judged = (orders) => orders.map((o) => ({ evidenceMs: o.judgedMs ?? o.evidenceMs }));
  const line = (name, ok, orders, miss, trip, sent) => {
    const s = evidenceStats(judged(orders), maxMs), raw = evidenceStats(orders, maxMs);
    const projected = orders.map((o) => o.fanout?.projectedMainnetMs).filter(Number.isFinite);
    return `${name.padEnd(width)}  ${mark(ok).padEnd(6)}  ${String(s.orders).padStart(6)}  ${ms(s.p50)} ${ms(s.p95)} ${ms(s.max)} ${ms(raw.max)} ${ms(projected.length ? Math.max(...projected) : null)} ${ms(windowMs)}` +
      `  ${count(miss)} ${count(trip)} ${s2(sent)}`;
  };
  const lines = [`pre-mainnet gate: every leg settled or refused for an expected reason, each order's judged evidence < ${maxMs} ms; ${evidenceWindowLabel(windowMs)}`,
    `${"scenario".padEnd(width)}  result  orders     p50    p95    max    raw  mainnet window   miss  trip   sent  (judged evidence ms: testnet without the dex fan-out; raw max; mainnet projection max; the evidence window in force;`,
    `${"".padEnd(width)}                                                                                      miss: criterion miss; trip: trip-wire hits; sent: dispatch created → order sent, s p50 (all: max))`];
  const classes = (r) => r.ok === null ? [null, null] : [r.criterionMiss ? 1 : 0, r.tripWire?.hits ?? 0];
  for (const r of rows) lines.push(line(r.name, r.ok, r.orders ?? [], ...classes(r), r.ok === null ? null : r.createdToSent?.p50 ?? null));
  if (rows.length > 1) {
    const ran = rows.filter((r) => r.ok !== null), maxima = ran.map((r) => r.createdToSent?.max).filter(Number.isFinite);
    lines.push(line("all", rows.some((r) => r.ok === false) ? false : ran.length === 0 ? null : true, rows.flatMap((r) => r.orders ?? []),
      ran.length ? ran.filter((r) => r.criterionMiss).length : null, ran.length ? ran.reduce((n, r) => n + (r.tripWire?.hits ?? 0), 0) : null, maxima.length ? Math.max(...maxima) : null));
  }
  return lines.join("\n");
}
