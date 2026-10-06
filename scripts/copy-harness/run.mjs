#!/usr/bin/env node
// Copy harness — the whole loop against the local stack, in one command.
//
//   node scripts/copy-harness/run.mjs [--dry-run] [--headed] [--gap 20]
//        [--web http://localhost:3000] [--api http://localhost:3100] [--worker http://localhost:3010]
//
// 1. leader and follower balances: too little stops the run (exit 3) before anything is signed;
// 2. cleanup: running copies of the harness leader are stopped, waiting setups cancelled, the leader flattened;
// 3. the leader sends 150 testnet USDC to the follower's main wallet (only when it holds < the budget);
// 4. a one-click copy of the leader (testnet source, fixed 12 USDC per trade, budget 100): the setup is
//    prepared through the api, and the browser (the Privy test account on the local web) confirms it from
//    the portfolio's 繼續設定 — it signs the consent and the deposit and calls addSigners;
// 5. wait for running; 6. leader.mjs scenario; 7. reconcile.mjs (five sources, the portfolio included);
// 8. withdraw 10 idle USDC and check the main wallet's credit;
// 9. stop: positions closed, the automatic return credited, the copy shown stopped;
// 10. a summary table (pass/fail per check, latency p50/p95).
//
// --dry-run needs no funds: login, cleanup, the setup up to its consent challenge, the browser's two
// signatures and addSigners (its /confirm is intercepted, so nothing is deposited), then cancel.
//
// The local api and worker must run with COPY_TRADING_MODE=testnet: `node scripts/copy-harness/stack.mjs
// restart worker` (and `api`) starts them with the harness profile (harness.env: testnet mode, the
// 2 s testnet source). Secrets (.env, the leader's key) stay in their processes.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT, HARNESS_LEADER, ROOT, TERMS, fundingGate, loadEnv, planCleanup, renderSummary, stopSettled, waitFor } from "./lib.mjs";
import { confirmFromPortfolio, launch, login } from "./follower.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(`--${name}`);
const WEB = flag("web", "http://localhost:3000"), API = flag("api", "http://localhost:3100"), WORKER = flag("worker", "http://localhost:3010");
const DRY = has("dry-run"), GAP = flag("gap", "20");
const OUT = resolve(ROOT, ".claude/logs/copy-harness"); mkdirSync(OUT, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); log("check", { name, ok, detail }); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helpers -------------------------------------------------------------------------------
const INFO = "https://api.hyperliquid-testnet.xyz/info";
const info = async (body) => { const r = await fetch(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`testnet ${body.type} ${r.status}`); return r.json(); };
/** USDC a wallet can move: the perp withdrawable plus free spot USDC. */
async function usdc(address) {
  const [perp, spot] = await Promise.all([info({ type: "clearinghouseState", user: address }), info({ type: "spotClearinghouseState", user: address })]);
  const s = spot.balances.find((b) => b.coin === "USDC");
  return { perp: Number(perp.withdrawable), spot: s ? Number(s.total) - Number(s.hold) : 0, total: Number(perp.withdrawable) + (s ? Number(s.total) - Number(s.hold) : 0),
    positions: perp.assetPositions.map((a) => ({ coin: a.position.coin, szi: Number(a.position.szi) })).filter((p) => p.szi !== 0), equity: Number(perp.marginSummary.accountValue) };
}
/** A child node script; its JSON lines are parsed, stdout echoed. */
function node(script, scriptArgs, { env = {}, quiet = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, script), ...scriptArgs], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on("data", (d) => { err += d; process.stderr.write(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      const lines = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolveRun({ code, out, err, lines });
    });
  });
}
async function leaderState() {
  const r = await node("leader.mjs", ["state"], { quiet: true });
  const state = r.lines.find((l) => l.event === "state");
  if (r.code !== 0 || !state) throw new Error(`leader.mjs state failed: ${r.err.trim().split("\n").at(-1)}`);
  return state;
}
async function health(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.status < 500; } catch { return false; } }

const env = loadEnv();
let browser = null, follower = null, setupId = null;
const summary = (extra = {}) => {
  const text = renderSummary({ checks, mode: DRY ? "dry run" : "full", ...extra });
  console.log(`\n${text}\n`);
  writeFileSync(resolve(OUT, `${runId}-summary.txt`), `${text}\n`);
  log("summary_written", { path: resolve(OUT, `${runId}-summary.txt`) });
};
const finish = async (code, extra) => {
  summary(extra);
  await browser?.close().catch(() => {});
  process.exit(code);
};

try {
  // --- 0. the local stack --------------------------------------------------------------------
  for (const [name, url] of [["web", WEB], ["api", `${API}/health`], ["worker", `${WORKER}/health`]])
    if (!check(`stack_${name}_up`, await health(url), url)) await finish(EXIT.failed);

  // --- 1. balances -----------------------------------------------------------------------------
  const leader = await leaderState();
  const leaderFree = Number(leader.withdrawable);
  log("leader", { address: leader.address, equity: leader.equity, withdrawable: leader.withdrawable, positions: leader.positions });

  // --- 2. the follower logs in ---------------------------------------------------------------------
  browser = await launch({ headless: !has("headed") });
  follower = await login(browser, { web: WEB, api: API, env, log });
  const main = follower.me.walletAddress;
  check("follower_login", true, `user ${follower.me.id}, main wallet ${main}`);
  const overview = await follower.client.get("/me/copy/live");
  if (!check("api_testnet_mode", overview.capabilities.automaticExecution && overview.capabilities.sourceNetworks.includes("testnet"),
    `automaticExecution=${overview.capabilities.automaticExecution}, sources=${overview.capabilities.sourceNetworks.join(",")}`)) await finish(EXIT.failed);
  const mainBefore = await usdc(main);
  log("follower_main", { address: main, perp: mainBefore.perp, spot: mainBefore.spot });
  const gate = fundingGate({ leader: leaderFree, follower: mainBefore.total });
  if (!gate.ok) {
    const spotHint = Number(leader.spotUsdc) > 0 ? ` The leader holds ${Number(leader.spotUsdc).toFixed(2)} USDC in spot: move it to perps first (usdClassTransfer).` : "";
    const message = `NOT FUNDED — ${gate.problems.join("; ")}. Fund the harness leader's perp account with testnet USDC (Hyperliquid testnet faucet, or a usdSend from a funded testnet wallet), then rerun.${spotHint}`;
    if (!DRY) { check("funded", false, message); console.error(`\n${message}\n`); await finish(EXIT.unfunded); }
    check("funded", null, `dry run continues without funds: ${gate.problems.join("; ")}`);
  } else check("funded", true, `leader ${leaderFree.toFixed(2)}, follower main ${mainBefore.total.toFixed(2)}${gate.send ? `, will send ${TERMS.sendUsd}` : ""}`);

  // --- 2b. cleanup (idempotent rerun) ------------------------------------------------------------
  const portfolio = async () => (await follower.client.get("/me/copy/live/portfolio")).items;
  const actions = planCleanup(await portfolio());
  log("cleanup_plan", { actions });
  for (const a of actions) {
    if (a.kind === "cancel_setup") await follower.client.post(`/me/copy/live/setups/${a.setupId}/cancel`).catch((e) => log("cleanup_cancel_failed", { setupId: a.setupId, error: e.message }));
    if (a.kind === "stop") await follower.client.post(`/me/copy/live/mandates/${a.mandateId}/stop`, { idempotencyKey: `harness-cleanup-${randomUUID()}`, expectedMandateRevision: a.revision });
    if (a.kind === "await_setup") log("cleanup_setup_in_progress", { setupId: a.setupId, note: "a confirmed setup can't be cancelled; it is stopped once it runs" });
  }
  if (actions.some((a) => a.kind === "stop" || a.kind === "await_stop" || a.kind === "await_setup")) {
    const settled = await waitFor(portfolio, (items) => planCleanup(items).every((a) => a.kind === "cancel_setup") && items.filter((i) => i.leaderAddress === HARNESS_LEADER).every((i) => i.stage === "stopped" ? stopSettled(i) : !["starting", "active", "paused", "stopping", "sweeping"].includes(i.stage)),
      { timeoutMs: 600_000, intervalMs: 5000 });
    if (!check("cleanup_previous_copies", settled.ok, settled.ok ? `${actions.length} action(s)` : "a previous copy did not settle in 10 min")) await finish(EXIT.failed);
  } else check("cleanup_previous_copies", true, actions.length ? `${actions.length} setup(s) cancelled` : "nothing to clean");
  if (leader.positions.length) {
    if (DRY) check("leader_flat", null, `leader holds ${JSON.stringify(leader.positions)} (dry run leaves it)`);
    else { const r = await node("leader.mjs", ["flatten"]); check("leader_flat", r.code === 0, "closed the leader's leftover positions"); }
  }

  // --- 3. the leader funds the follower ------------------------------------------------------------
  if (!DRY && gate.send) {
    const r = await node("leader.mjs", ["send", main, String(TERMS.sendUsd)]);
    const credited = await waitFor(() => usdc(main), (b) => b.total >= mainBefore.total + TERMS.sendUsd - 1, { timeoutMs: 90_000, intervalMs: 3000 });
    if (!check("leader_sent_150", r.code === 0 && credited.ok, `main wallet ${mainBefore.total.toFixed(2)} → ${credited.value.total.toFixed(2)}`)) await finish(EXIT.failed);
  } else if (!DRY) check("leader_sent_150", null, `not needed: main wallet holds ${mainBefore.total.toFixed(2)}`);

  // --- 4. the one-click copy -------------------------------------------------------------------------
  const settings = { direction: "same", sizingMode: "fixed", perTradeUsd: TERMS.perTradeUsd, maxTotalExposureUsd: null, maxLeverage: 3, copyStartMode: "delta" };
  const startBody = { idempotencyKey: `harness-${randomUUID()}`, leader: HARNESS_LEADER, sourceNetwork: "testnet", budgetUsd: String(TERMS.budgetUsd), settings };
  const prepared = await waitFor(() => follower.client.post("/me/copy/live/setups", startBody), (s) => s.stage !== "provisioning", { timeoutMs: 60_000, intervalMs: 2000 });
  const setup = prepared.value;
  setupId = setup.id;
  const consent = setup.consent;
  if (!check("setup_prepared", prepared.ok && setup.stage === "awaiting_consent" && consent?.sourceNetwork === "testnet" && consent?.leaderAddress === HARNESS_LEADER &&
      consent?.budgetUsd === String(TERMS.budgetUsd) && consent?.fundingAmount === String(TERMS.budgetUsd) && Boolean(consent?.masterPolicyId && consent?.workerQuorumId),
    `setup ${setup.id} ${setup.stage}${setup.issue ? ` (${setup.issue})` : ""}, source ${consent?.sourceNetwork}, budget ${consent?.budgetUsd}, account ${consent?.accountAddress}`)) await finish(EXIT.failed);

  const confirmed = await confirmFromPortfolio(follower.page, { web: WEB, setupId, dryRun: DRY, log });
  log("browser_confirm", confirmed);
  check("browser_signed_consent_and_deposit", Boolean(confirmed.confirmRequest?.consentSignature && confirmed.confirmRequest?.fundingSignature),
    confirmed.confirmRequest ? `consent ${confirmed.confirmRequest.consentSignature}, deposit ${confirmed.confirmRequest.fundingSignature}` : `no /confirm sent (${confirmed.outcome}${confirmed.alert ? `: ${confirmed.alert}` : ""})`);
  // addSigners is Privy's wallet update (PATCH /api/v1/wallets/:id); /confirm leaves the browser only after it resolved.
  const signerUpdate = confirmed.privy.find((c) => /^PATCH \/api\/v1\/wallets\/:id 2\d\d$/.test(c));
  check("browser_added_worker_signer", Boolean(signerUpdate) && confirmed.confirmRequest?.setupId === setupId,
    `${signerUpdate ?? "no Privy wallet update"}; ${confirmed.outcome} after ${(confirmed.ms / 1000).toFixed(1)} s; privy: ${confirmed.privy.filter((c) => !c.includes("analytics")).join(", ")}`);

  if (DRY) {
    const cancelled = await follower.client.post(`/me/copy/live/setups/${setupId}/cancel`);
    check("dry_run_cancelled", cancelled.stage === "cancelled", `setup ${setupId} ${cancelled.stage}`);
    const after = await usdc(main);
    check("dry_run_nothing_deposited", Math.abs(after.total - mainBefore.total) < 1e-6, `main wallet ${mainBefore.total.toFixed(2)} → ${after.total.toFixed(2)}`);
    await finish(checks.some((c) => c.ok === false) ? EXIT.failed : EXIT.green);
  }
  if (!check("setup_confirmed", confirmed.outcome === "confirmed", `${confirmed.outcome} ${confirmed.confirmStatus ?? ""} ${JSON.stringify(confirmed.confirmBody?.error ?? confirmed.confirmBody?.data?.stage ?? "").slice(0, 160)}`)) await finish(EXIT.failed);

  // --- 5. running ---------------------------------------------------------------------------------------
  const t5 = Date.now();
  const running = await waitFor(() => follower.client.get(`/me/copy/live/setups/${setupId}`), (s) => ["running", "failed", "expired", "cancelled"].includes(s.stage),
    { timeoutMs: 600_000, intervalMs: 3000, onTick: (s) => log("setup_stage", { stage: s.stage, issue: s.issue }) });
  if (!check("setup_running", running.value.stage === "running", `${running.value.stage}${running.value.issue ? ` (${running.value.issue})` : ""} after ${((Date.now() - t5) / 1000).toFixed(0)} s`)) await finish(EXIT.failed);
  const item = async () => (await portfolio()).find((i) => i.strategyId === running.value.strategyId);
  const active = await waitFor(item, (i) => i?.stage === "active", { timeoutMs: 120_000, intervalMs: 3000 });
  const account = active.value?.accountAddress, accountId = active.value?.accountId;
  if (!check("portfolio_active", active.ok, `strategy ${running.value.strategyId}, account ${account}, stage ${active.value?.stage}`)) await finish(EXIT.failed);

  // --- 6. the leader's scenario -------------------------------------------------------------------------
  const since = new Date(Date.now() - 1000).toISOString();
  const scenario = await node("leader.mjs", ["scenario", "--gap", GAP]);
  if (!check("leader_scenario", scenario.code === 0, `${scenario.lines.filter((l) => l.event === "trade").length} leader orders`)) await finish(EXIT.failed);

  // --- 7. reconcile (retried while the copy catches up) ---------------------------------------------------
  let reconcile = null;
  const reconcileArgs = ["--leader", HARNESS_LEADER, "--leader-network", "testnet", "--follower", account, "--network", "testnet", "--since", since, "--db", "env", "--portfolio-url", `${API}/me/copy/live/portfolio`];
  const t7 = Date.now();
  for (let attempt = 1; ; attempt++) {
    const r = await node("reconcile.mjs", reconcileArgs, { quiet: true, env: { HARNESS_BEARER: await follower.token(), HARNESS_DATABASE_URL: env.DATABASE_URL } });
    try { reconcile = JSON.parse(r.out); } catch { reconcile = { failures: [{ check: "reconcile_crashed", detail: r.err.trim().split("\n").slice(-3).join(" ") }] }; }
    log("reconcile_attempt", { attempt, code: r.code, failures: reconcile.failures?.map((f) => f.check) });
    if (r.code === 0 || Date.now() - t7 > 240_000) break;
    await sleep(15_000);
  }
  writeFileSync(resolve(OUT, `${runId}-reconcile.json`), `${JSON.stringify(reconcile, null, 2)}\n`);
  check("reconcile_five_sources", reconcile.failures?.length === 0, reconcile.failures?.length ? reconcile.failures.map((f) => f.check).join(", ") : `${reconcile.leader?.orders} leader orders, ${reconcile.dispatches?.count} dispatches, ${reconcile.follower?.fills} follower fills`);

  // --- 8. withdraw 10 idle USDC ------------------------------------------------------------------------------
  const beforeWithdraw = await usdc(main);
  try {
    const reserved = await follower.client.post(`/me/copy/live/execution-wallets/${accountId}/returns`, { idempotencyKey: randomUUID(), amount: String(TERMS.withdrawUsd) });
    const op = reserved.operation ?? reserved;
    await follower.client.post(`/me/copy/live/returns/${op.id}/approve`);
    const done = await waitFor(async () => (await follower.client.get("/me/copy/funding")).operations.find((o) => o.id === op.id), (o) => ["credited", "rejected", "cancelled"].includes(o?.status), { timeoutMs: 180_000, intervalMs: 3000 });
    const after = await usdc(main);
    check("withdraw_10_credited", done.value?.status === "credited" && after.total >= beforeWithdraw.total + TERMS.withdrawUsd - 1.5,
      `return ${op.id} ${done.value?.status}, main wallet ${beforeWithdraw.total.toFixed(2)} → ${after.total.toFixed(2)}`);
  } catch (error) { check("withdraw_10_credited", false, error.message); }

  // --- 9. stop: positions closed, the automatic return credited, shown stopped -------------------------------
  const beforeStop = await usdc(main);
  const current = await item();
  try {
    await follower.client.post(`/me/copy/live/mandates/${current.mandate.id}/stop`, { idempotencyKey: `harness-stop-${randomUUID()}`, expectedMandateRevision: current.mandate.revision });
    const stopped = await waitFor(item, stopSettled, { timeoutMs: 600_000, intervalMs: 5000, onTick: (i) => log("stop_stage", { stage: i?.stage, stop: i?.stop?.state, issue: i?.stop?.issue, sweep: i?.sweep }) });
    const copyAccount = await usdc(account), afterStop = await usdc(main);
    check("stop_positions_closed", copyAccount.positions.length === 0, copyAccount.positions.length ? JSON.stringify(copyAccount.positions) : "copy account flat");
    check("stop_return_credited", stopped.value?.sweep?.status === "credited" && afterStop.total > beforeStop.total,
      `sweep ${JSON.stringify(stopped.value?.sweep)}, main wallet ${beforeStop.total.toFixed(2)} → ${afterStop.total.toFixed(2)}, copy account left ${copyAccount.total.toFixed(2)}`);
    check("stop_shown_stopped", stopped.value?.stage === "stopped", `stage ${stopped.value?.stage}, stop ${stopped.value?.stop?.state}`);
  } catch (error) { check("stop_shown_stopped", false, error.message); }

  const latency = reconcile?.latencySeconds ? { "signal received": reconcile.latencySeconds.received, "order sent": reconcile.latencySeconds.sent } : null;
  await finish(checks.some((c) => c.ok === false) ? EXIT.failed : EXIT.green, { latency, weightPerOrder: "n/a (the testnet bucket is not exposed by the worker)" });
} catch (error) {
  check("harness_error", false, `${error.name}: ${error.message}`);
  if (DRY && setupId) await follower?.client.post(`/me/copy/live/setups/${setupId}/cancel`).then((s) => log("dry_run_cancelled_after_error", { stage: s.stage }), () => {});
  await finish(EXIT.failed);
}
