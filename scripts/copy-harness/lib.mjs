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
 * budget; the leader then needs the send plus room for its scenario. Zero
 * (or too little) on either side stops the run before anything is signed. */
export function fundingGate({ leader, follower, terms = TERMS }) {
  const send = follower < terms.budgetUsd;
  const leaderNeeds = terms.leaderScenarioUsd + (send ? terms.sendUsd : 0);
  const problems = [];
  if (leader < leaderNeeds) {
    problems.push(`the harness leader ${HARNESS_LEADER} holds ${leader.toFixed(2)} testnet USDC and needs at least ${leaderNeeds.toFixed(2)}` +
      (send ? ` (${terms.sendUsd} for the follower, ${terms.leaderScenarioUsd} for its scenario)` : ` (for its scenario)`));
    if (send) problems.push(`the follower's main wallet holds ${follower.toFixed(2)} testnet USDC, under the ${terms.budgetUsd} USDC budget, and the leader can't top it up`);
  }
  return { ok: problems.length === 0, send, leaderNeeds, problems };
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
    lines.push("", "latency (s from the leader's fill)    p50     p95     max");
    for (const [name, v] of Object.entries(latency)) lines.push(`  ${name.padEnd(35)} ${fmt(v?.p50)} ${fmt(v?.p95)} ${fmt(v?.max)}`);
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

/** The run's terms per stack profile: `default` (harness.env) or `stage-caps`
 * (stage-caps.env over it: Stage's caps, 12–15 per trade, 50 per copy, leverage 3). */
export function termsFor(profile = "default") {
  if (profile === "default") return { ...TERMS, maxPerTradeUsd: TERMS.perTradeUsd, maxLeverage: 3, profile };
  if (profile === "stage-caps") return { ...TERMS, budgetUsd: 50, maxPerTradeUsd: 15, maxLeverage: 3, profile };
  throw new Error(`unknown profile ${profile} (default | stage-caps)`);
}

/**
 * The scenarios run.mjs can run (`--scenarios a,b,c`, by name or number).
 * `endsCopy`: it stops the copy, so the next scenario starts a new one.
 */
export const SCENARIOS = Object.freeze({
  base: { no: "1", endsCopy: true, about: "open, add, reduce half, close, short, flip, close; withdraw 10; stop with the return credited" },
  "reduce-min": { no: "3", endsCopy: false, about: "reduce 25 % of a 24 USD position (under the 10 USD minimum), then a full close" },
  "stop-open": { no: "4", endsCopy: true, about: "stop while a position is open: closed flat, the return credited, shown stopped" },
  "close-then-stop": { no: "6", endsCopy: true, about: "the owner's single-position close, then a stop within 2 s: flat and stopped, never blocked" },
  "worker-restart": { no: "7", endsCopy: false, about: "the worker restarts between a leader trade and its fill: no double send, later legs trade" },
  "refused-open": { no: "8", endsCopy: false, about: "an open refused under the order minimum (below_min_notional), then later legs, a close included, execute" },
  burst: { no: "9", endsCopy: false, about: "the leader closes in 3 fills within 20 s; the follower ends flat" },
  "kill-switch": { no: "14", endsCopy: true, about: "platform pause (opens refused, reductions mirrored), then admin close-all closes and returns" },
});
/** `--scenarios` → scenario names, in the given order (default: base). */
export function parseScenarios(value) {
  if (!value) return ["base"];
  const names = value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
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
