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
