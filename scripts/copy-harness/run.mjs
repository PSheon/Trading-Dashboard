#!/usr/bin/env node
// Copy harness — the whole loop against the local stack, in one command.
//
//   node scripts/copy-harness/run.mjs [--dry-run] [--headed] [--gap 20] [--scenarios base,3,4,…]
//        [--profile default|stage-caps] [--web http://localhost:3000] [--api http://localhost:3100] [--worker http://localhost:3010]
//
// 1. leader and follower balances: too little stops the run (exit 3) before anything is signed;
// 2. cleanup: running copies of the harness leader are stopped, waiting setups cancelled, the leader flattened;
// 3. the leader sends 150 testnet USDC to the follower's main wallet (only when it holds < the budget);
// 4. a one-click copy of the leader (testnet source, fixed 12 USDC per trade, the profile's budget): the setup
//    is prepared through the api, and the browser (the Privy test account on the local web) confirms it from
//    the portfolio's 繼續設定 — it signs the consent and the deposit and calls addSigners; 5. wait for running;
// 6. the scenarios (lib.mjs SCENARIOS; a scenario that stops the copy makes the next one start a new copy):
//    base   (1) leader.mjs scenario, reconcile, withdraw 10 idle USDC, stop with the return credited;
//    reduce-min (3) reduce 25 % of a 24 USD position, then a full close; reconciled;
//    stop-open (4) stop while a position is open: flat, the automatic return credited, shown stopped;
//    close-then-stop (6) the owner's single-position close, then a stop within 2 s: never blocked, flat, stopped;
//    worker-restart (7) `stack.mjs restart worker` between a leader trade and its fill: no double send, later legs trade;
//    refused-open (8) an open refused under the order minimum, then later legs (a close included) execute;
//    burst (9) the leader closes in 3 fills within 20 s: the follower ends flat;
//    kill-switch (14) platform pause (opens refused, reductions mirrored), then admin close-all closes and returns;
//    each reconciled by reconcile.mjs with the profile's rules (fixed size, leverage cap, refusal allowlist, flat);
// 7. a copy still running at the end is stopped; a summary table (pass/fail per check, latency p50/p95).
//
// --dry-run needs no funds: login, cleanup, the setup up to its consent challenge, the browser's two
// signatures and addSigners (its /confirm is intercepted, so nothing is deposited; with an empty main
// wallet the real /confirm goes out and must be refused 409 insufficient_main_balance), then cancel;
// and each scenario's leader legs planned from live markets (leader.mjs --dry-run, nothing signed).
//
// The local api and worker must run with COPY_TRADING_MODE=testnet: `node scripts/copy-harness/stack.mjs
// restart worker` (and `api`) starts them with the harness profile (harness.env: testnet mode, the
// 3 s testnet source); add `--profile stage-caps` to both (and to run.mjs) for Stage's caps.
// kill-switch needs an admin bearer with execution.pause/resume: HARNESS_ADMIN_TOKEN, else the
// api's AUTH_SERVICE_TOKEN from .env. Secrets (.env, the leader's key) stay in their processes.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT, HARNESS_LEADER, ROOT, SCENARIOS, fundingGate, loadEnv, parseScenarios, planCleanup, renderSummary, stopSettled, termsFor, waitFor } from "./lib.mjs";
import { apiClient, confirmFromPortfolio, launch, login } from "./follower.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(`--${name}`);
const WEB = flag("web", "http://localhost:3000"), API = flag("api", "http://localhost:3100"), WORKER = flag("worker", "http://localhost:3010");
const DRY = has("dry-run"), GAP = flag("gap", "20");
let SCENARIO_LIST, TERMS;
try { SCENARIO_LIST = parseScenarios(flag("scenarios")); TERMS = termsFor(flag("profile", "default")); }
catch (error) { console.error(error.message); process.exit(EXIT.usage); }
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
  // Only our isolated context is owned; preserve the shared Stage login.
  await follower?.context?.close().catch(() => {});
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
  // Testnet only: a stack whose copies run on mainnet is refused before anything is prepared.
  if (!check("api_testnet_mode", overview.network === "testnet" && overview.capabilities.automaticExecution && overview.capabilities.sourceNetworks.includes("testnet") && overview.capabilities.actualAllowed !== false,
    `network=${overview.network}, automaticExecution=${overview.capabilities.automaticExecution}, sources=${overview.capabilities.sourceNetworks.join(",")}, actualAllowed=${overview.capabilities.actualAllowed ?? "n/a"}`)) await finish(EXIT.failed);
  const mainBefore = await usdc(main);
  log("follower_main", { address: main, perp: mainBefore.perp, spot: mainBefore.spot });
  const gate = fundingGate({ leader: leaderFree, follower: mainBefore.total, terms: TERMS });
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

  // --- 4–5. a running one-click copy ------------------------------------------------------------------
  const settings = { direction: "same", sizingMode: "fixed", perTradeUsd: TERMS.perTradeUsd, maxTotalExposureUsd: null, maxLeverage: TERMS.maxLeverage, copyStartMode: "delta" };
  /** Prepares a copy, confirms it in the browser and waits until it runs. Dry run: stops after the consent. */
  async function startCopy(label) {
    const startBody = { idempotencyKey: `harness-${randomUUID()}`, leader: HARNESS_LEADER, sourceNetwork: "testnet", budgetUsd: String(TERMS.budgetUsd), settings };
    const prepared = await waitFor(() => follower.client.post("/me/copy/live/setups", startBody), (s) => s.stage !== "provisioning", { timeoutMs: 60_000, intervalMs: 2000 });
    const setup = prepared.value;
    setupId = setup.id;
    const consent = setup.consent;
    if (!check(`${label}_setup_prepared`, prepared.ok && setup.stage === "awaiting_consent" && consent?.sourceNetwork === "testnet" && consent?.leaderAddress === HARNESS_LEADER &&
        consent?.budgetUsd === String(TERMS.budgetUsd) && consent?.fundingAmount === String(TERMS.budgetUsd) && Boolean(consent?.masterPolicyId && consent?.workerQuorumId),
      `setup ${setup.id} ${setup.stage}${setup.issue ? ` (${setup.issue})` : ""}, source ${consent?.sourceNetwork}, budget ${consent?.budgetUsd}, account ${consent?.accountAddress}`)) await finish(EXIT.failed);

    // A dry run never deposits: its /confirm is intercepted, except while the main wallet can't cover the
    // budget, when the real /confirm must be refused (409 insufficient_main_balance) with nothing sent.
    const unfundedConfirm = DRY && mainBefore.total < TERMS.budgetUsd;
    const confirmed = await confirmFromPortfolio(follower.page, { web: WEB, setupId, dryRun: DRY && !unfundedConfirm, log });
    log("browser_confirm", confirmed);
    check(`${label}_browser_signed_consent_and_deposit`, Boolean(confirmed.confirmRequest?.consentSignature && confirmed.confirmRequest?.fundingSignature),
      confirmed.confirmRequest ? `consent ${confirmed.confirmRequest.consentSignature}, deposit ${confirmed.confirmRequest.fundingSignature}` : `no /confirm sent (${confirmed.outcome}${confirmed.alert ? `: ${confirmed.alert}` : ""})`);
    // addSigners is Privy's wallet update (PATCH /api/v1/wallets/:id); /confirm leaves the browser only after it resolved.
    const signerUpdate = confirmed.privy.find((c) => /^PATCH \/api\/v1\/wallets\/:id 2\d\d$/.test(c));
    check(`${label}_browser_added_worker_signer`, Boolean(signerUpdate) && confirmed.confirmRequest?.setupId === setupId,
      `${signerUpdate ?? "no Privy wallet update"}; ${confirmed.outcome} after ${(confirmed.ms / 1000).toFixed(1)} s; privy: ${confirmed.privy.filter((c) => !c.includes("analytics")).join(", ")}`);

    if (DRY) {
      if (unfundedConfirm) check("dry_run_unfunded_confirm_refused", confirmed.confirmStatus === 409 && confirmed.confirmBody?.error?.code === "insufficient_main_balance",
        `${confirmed.confirmStatus} ${confirmed.confirmBody?.error?.code ?? confirmed.outcome}`);
      const cancelled = await follower.client.post(`/me/copy/live/setups/${setupId}/cancel`);
      check("dry_run_cancelled", cancelled.stage === "cancelled", `setup ${setupId} ${cancelled.stage}`);
      const after = await usdc(main);
      check("dry_run_nothing_deposited", Math.abs(after.total - mainBefore.total) < 1e-6, `main wallet ${mainBefore.total.toFixed(2)} → ${after.total.toFixed(2)}`);
      return null;
    }
    if (!check(`${label}_setup_confirmed`, confirmed.outcome === "confirmed", `${confirmed.outcome} ${confirmed.confirmStatus ?? ""} ${JSON.stringify(confirmed.confirmBody?.error ?? confirmed.confirmBody?.data?.stage ?? "").slice(0, 160)}`)) await finish(EXIT.failed);
    const t5 = Date.now();
    const running = await waitFor(() => follower.client.get(`/me/copy/live/setups/${setupId}`), (s) => ["running", "failed", "expired", "cancelled"].includes(s.stage),
      { timeoutMs: 600_000, intervalMs: 3000, onTick: (s) => log("setup_stage", { stage: s.stage, issue: s.issue }) });
    if (!check(`${label}_setup_running`, running.value.stage === "running", `${running.value.stage}${running.value.issue ? ` (${running.value.issue})` : ""} after ${((Date.now() - t5) / 1000).toFixed(0)} s`)) await finish(EXIT.failed);
    const strategyId = running.value.strategyId;
    const item = async () => (await portfolio()).find((i) => i.strategyId === strategyId);
    const active = await waitFor(item, (i) => i?.stage === "active", { timeoutMs: 120_000, intervalMs: 3000 });
    if (!check(`${label}_portfolio_active`, active.ok, `strategy ${strategyId}, account ${active.value?.accountAddress}, stage ${active.value?.stage}`)) await finish(EXIT.failed);
    return { strategyId, account: active.value.accountAddress, accountId: active.value.accountId, item };
  }

  // --- helpers of the scenarios -----------------------------------------------------------------------------
  const leaderRun = async (label, leaderArgs) => {
    const r = await node("leader.mjs", leaderArgs);
    check(`${label}_leader`, r.code === 0, `${leaderArgs.join(" ")}: ${r.lines.filter((l) => l.event === "trade").length} order(s)${r.code ? `, ${r.err.trim().split("\n").at(-1)}` : ""}`);
    return r;
  };
  const followerHolds = (copy, coin) => waitFor(() => usdc(copy.account), (b) => b.positions.some((p) => p.coin === coin), { timeoutMs: 120_000, intervalMs: 3000 });
  let lastReconcile = null;
  /** reconcile.mjs over [since, now] with the profile's rules, retried while the copy catches up. */
  async function reconcileCheck(label, copy, since, allow = []) {
    const reconcileArgs = ["--leader", HARNESS_LEADER, "--leader-network", "testnet", "--follower", copy.account, "--network", "testnet", "--since", since, "--db", "env",
      "--portfolio-url", `${API}/me/copy/live/portfolio`, "--per-trade-usd", String(TERMS.perTradeUsd), "--max-per-trade-usd", String(TERMS.maxPerTradeUsd),
      "--max-leverage", String(TERMS.maxLeverage), ...allow.flatMap((a) => ["--allow-refusal", a])];
    let reconcile = null;
    const t0 = Date.now();
    for (let attempt = 1; ; attempt++) {
      const r = await node("reconcile.mjs", reconcileArgs, { quiet: true, env: { HARNESS_BEARER: await follower.token(), HARNESS_DATABASE_URL: env.DATABASE_URL } });
      try { reconcile = JSON.parse(r.out); } catch { reconcile = { failures: [{ check: "reconcile_crashed", detail: r.err.trim().split("\n").slice(-3).join(" ") }] }; }
      log("reconcile_attempt", { scenario: label, attempt, code: r.code, failures: reconcile.failures?.map((f) => f.check) });
      if (r.code === 0 || Date.now() - t0 > 240_000) break;
      await sleep(15_000);
    }
    writeFileSync(resolve(OUT, `${runId}-${label}-reconcile.json`), `${JSON.stringify(reconcile, null, 2)}\n`);
    check(`${label}_reconcile`, reconcile.failures?.length === 0, reconcile.failures?.length ? reconcile.failures.map((f) => f.check).join(", ")
      : `${reconcile.leader?.orders} leader orders, ${reconcile.dispatches?.count} dispatches, ${reconcile.follower?.fills} follower fills`);
    lastReconcile = reconcile;
    return reconcile;
  }
  /** Stops the copy (unless `asked` already did), then: flat, the automatic return credited, shown stopped, never blocked. */
  async function stopCheck(label, copy, { request = true } = {}) {
    const beforeStop = await usdc(main);
    let blocked = null;
    try {
      const current = await copy.item();
      if (request) await follower.client.post(`/me/copy/live/mandates/${current.mandate.id}/stop`, { idempotencyKey: `harness-stop-${randomUUID()}`, expectedMandateRevision: current.mandate.revision });
      const stopped = await waitFor(copy.item, stopSettled, { timeoutMs: 600_000, intervalMs: 5000, onTick: (i) => {
        if (i?.stop?.state === "blocked") blocked = i.stop.issue;
        log("stop_stage", { scenario: label, stage: i?.stage, stop: i?.stop?.state, issue: i?.stop?.issue, sweep: i?.sweep });
      } });
      const copyAccount = await usdc(copy.account), afterStop = await usdc(main);
      check(`${label}_stop_never_blocked`, blocked === null, blocked ? `stop blocked: ${blocked}` : "");
      check(`${label}_stop_positions_closed`, copyAccount.positions.length === 0, copyAccount.positions.length ? JSON.stringify(copyAccount.positions) : "copy account flat");
      check(`${label}_stop_return_credited`, stopped.value?.sweep?.status === "credited" && afterStop.total > beforeStop.total,
        `sweep ${JSON.stringify(stopped.value?.sweep)}, main wallet ${beforeStop.total.toFixed(2)} → ${afterStop.total.toFixed(2)}, copy account left ${copyAccount.total.toFixed(2)}`);
      check(`${label}_stop_shown_stopped`, stopped.value?.stage === "stopped", `stage ${stopped.value?.stage}, stop ${stopped.value?.stop?.state}`);
    } catch (error) { check(`${label}_stop_shown_stopped`, false, error.message); }
  }
  const nowIso = () => new Date(Date.now() - 1000).toISOString();
  const profileArgs = TERMS.profile === "stage-caps" ? ["--profile", "stage-caps"] : [];
  const sizingArgs = ["--per-trade", String(TERMS.perTradeUsd), "--max-per-trade", String(TERMS.maxPerTradeUsd)];
  /** An admin client (kill switch): HARNESS_ADMIN_TOKEN, else the api's service token; never printed. */
  const adminToken = process.env.HARNESS_ADMIN_TOKEN || env.AUTH_SERVICE_TOKEN || null;
  const admin = adminToken ? apiClient(API, async () => adminToken) : null;

  /** Each scenario runs on `copy` (a running copy) and returns whether the copy still runs. */
  const scenarios = {
    async base(copy) {
      const since = nowIso();
      await leaderRun("base", ["scenario", "base", "--gap", GAP]);
      await reconcileCheck("base", copy, since);
      // Withdraw 10 idle USDC.
      const beforeWithdraw = await usdc(main);
      try {
        const reserved = await follower.client.post(`/me/copy/live/execution-wallets/${copy.accountId}/returns`, { idempotencyKey: randomUUID(), amount: String(TERMS.withdrawUsd) });
        const op = reserved.operation ?? reserved;
        await follower.client.post(`/me/copy/live/returns/${op.id}/approve`);
        const done = await waitFor(async () => (await follower.client.get("/me/copy/funding")).operations.find((o) => o.id === op.id), (o) => ["credited", "rejected", "cancelled"].includes(o?.status), { timeoutMs: 180_000, intervalMs: 3000 });
        const after = await usdc(main);
        check("base_withdraw_10_credited", done.value?.status === "credited" && after.total >= beforeWithdraw.total + TERMS.withdrawUsd - 1.5,
          `return ${op.id} ${done.value?.status}, main wallet ${beforeWithdraw.total.toFixed(2)} → ${after.total.toFixed(2)}`);
      } catch (error) { check("base_withdraw_10_credited", false, error.message); }
      await stopCheck("base", copy);
      return false;
    },
    async "reduce-min"(copy) {
      const since = nowIso();
      await leaderRun("reduce_min", ["scenario", "reduce-min", "--gap", GAP]);
      await reconcileCheck("reduce_min", copy, since);
      return true;
    },
    async "stop-open"(copy) {
      const since = nowIso();
      await leaderRun("stop_open", ["open", "ETH", "20"]);
      const held = await followerHolds(copy, "ETH");
      check("stop_open_mirrored", held.ok, JSON.stringify(held.value.positions));
      await reconcileCheck("stop_open", copy, since);
      // Stop before the leader's close: the stop closes the open position.
      await stopCheck("stop_open", copy);
      await leaderRun("stop_open_cleanup", ["close", "ETH"]);
      return false;
    },
    async "close-then-stop"(copy) {
      const since = nowIso();
      await leaderRun("close_then_stop", ["open", "ETH", "20"]);
      const held = await followerHolds(copy, "ETH");
      check("close_then_stop_mirrored", held.ok, JSON.stringify(held.value.positions));
      await reconcileCheck("close_then_stop", copy, since);
      try {
        const close = await follower.client.post(`/me/copy/live/execution-wallets/${copy.accountId}/positions/close`, { idempotencyKey: randomUUID(), coin: "ETH" });
        check("close_then_stop_close_requested", close.state === "requested", `close ${close.id} ${close.state}`);
      } catch (error) { check("close_then_stop_close_requested", false, error.message); }
      await sleep(1500); // the stop within 2 s, while the close is in flight
      await stopCheck("close_then_stop", copy);
      await leaderRun("close_then_stop_cleanup", ["close", "ETH"]);
      return false;
    },
    async "worker-restart"(copy) {
      const since = nowIso();
      await leaderRun("worker_restart", ["open", "ETH", "20"]);
      // Right after the leader's trade, before the copy's fill.
      const restart = await node("stack.mjs", ["restart", "worker", ...profileArgs]);
      check("worker_restart_restarted", restart.code === 0, restart.lines.find((l) => l.event === "started") ? `worker pid ${restart.lines.find((l) => l.event === "started").pid}` : restart.err.trim().split("\n").at(-1));
      const held = await followerHolds(copy, "ETH");
      check("worker_restart_mirrored", held.ok, JSON.stringify(held.value.positions));
      await sleep(Number(GAP) * 1000);
      await leaderRun("worker_restart_reduce", ["reduce", "ETH", "0.5"]);
      await sleep(Number(GAP) * 1000);
      await leaderRun("worker_restart_close", ["close", "ETH"]);
      // No double send (an order outside the legs fails the reconcile), and the later legs traded.
      await reconcileCheck("worker_restart", copy, since);
      return true;
    },
    async "refused-open"(copy) {
      const since = nowIso();
      const r = await leaderRun("refused_open", ["scenario", "refused-open", "--gap", GAP, ...sizingArgs]);
      const odd = r.lines.find((l) => l.event === "start")?.refusable;
      if (!odd) { check("refused_open_coin", null, "no testnet perp makes the fixed amount fall under the minimum within the cap (skipped)"); return true; }
      await reconcileCheck("refused_open", copy, since, [`below_min_notional:${odd.coin}`]);
      const refused = (lastReconcile?.dispatches?.byStateReason ?? {})["refused/below_min_notional"] ?? 0;
      check("refused_open_was_refused", refused >= 1, `${refused} leg(s) refused below_min_notional on ${odd.coin}`);
      return true;
    },
    async burst(copy) {
      const since = nowIso();
      await leaderRun("burst", ["scenario", "burst", "--gap", GAP]);
      await reconcileCheck("burst", copy, since);
      const flat = await waitFor(() => usdc(copy.account), (b) => b.positions.length === 0, { timeoutMs: 120_000, intervalMs: 3000 });
      check("burst_follower_flat", flat.ok, JSON.stringify(flat.value.positions));
      return true;
    },
    async "kill-switch"(copy) {
      if (!admin) { check("kill_switch_admin", false, "no admin token (HARNESS_ADMIN_TOKEN or AUTH_SERVICE_TOKEN)"); return true; }
      const since = nowIso();
      const control = async (command, reason) => {
        const overview = await admin.get("/admin/copy/overview");
        return admin.post("/admin/copy/controls", { scope: "platform", command, reason, expectedRevision: overview.platform.revision });
      };
      let resumed = false;
      try {
        await leaderRun("kill_switch_open", ["open", "ETH", "20"]);
        const held = await followerHolds(copy, "ETH");
        check("kill_switch_mirrored", held.ok, JSON.stringify(held.value.positions));
        const before = held.value.positions.find((p) => p.coin === "ETH")?.szi ?? 0;
        await control("pause_new_risk", "copy harness kill switch drill");
        // An add is refused while paused…
        await leaderRun("kill_switch_add", ["open", "ETH", "20"]);
        await sleep(30_000);
        const afterAdd = (await usdc(copy.account)).positions.find((p) => p.coin === "ETH")?.szi ?? 0;
        check("kill_switch_open_refused", Math.abs(afterAdd) <= Math.abs(before) + 1e-9, `follower ETH ${before} → ${afterAdd}`);
        // …a reduction is still mirrored.
        await leaderRun("kill_switch_reduce", ["reduce", "ETH", "0.5"]);
        const reduced = await waitFor(() => usdc(copy.account), (b) => Math.abs(b.positions.find((p) => p.coin === "ETH")?.szi ?? 0) < Math.abs(afterAdd) - 1e-9, { timeoutMs: 120_000, intervalMs: 3000 });
        check("kill_switch_reduction_mirrored", reduced.ok, JSON.stringify(reduced.value.positions));
        await reconcileCheck("kill_switch", copy, since, ["platform_paused:ETH"]);
        // Admin close-all: the copy's stop closes and returns.
        try {
          const closed = await control("close_positions", "copy harness kill switch drill");
          check("kill_switch_close_all_complete", closed.event?.result?.complete === true && closed.event.result.liveStops >= 1, JSON.stringify(closed.event?.result));
        } catch (error) { check("kill_switch_close_all_complete", false, error.message); }
        await stopCheck("kill_switch", copy, { request: false });
        await control("resume", "copy harness kill switch drill over"); resumed = true;
      } finally {
        // Never leave the platform paused.
        if (!resumed) await control("resume", "copy harness kill switch drill over").catch((error) => check("kill_switch_resumed", false, error.message));
        await node("leader.mjs", ["flatten"], { quiet: true });
      }
      return false;
    },
  };

  // --- 6. the scenarios ---------------------------------------------------------------------------------------
  log("scenarios", { list: SCENARIO_LIST, profile: TERMS.profile, terms: TERMS });
  if (DRY) {
    await startCopy("dry_run");
    // Each scenario's leader legs, planned from live markets (nothing signed).
    for (const name of SCENARIO_LIST) {
      const leaderScenario = ["base", "reduce-min", "burst", "refused-open"].includes(name) ? name : null;
      if (!leaderScenario) { check(`dry_run_${name}_planned`, null, `${SCENARIOS[name].about} (orchestrated live; no leader plan)`); continue; }
      const r = await node("leader.mjs", ["scenario", leaderScenario, "--dry-run", ...sizingArgs], { quiet: true });
      check(`dry_run_${name}_planned`, r.code === 0, r.code === 0 ? r.lines.filter((l) => l.event === "trade_planned").map((l) => l.label).join(" → ") : r.err.trim().split("\n").at(-1));
    }
    await finish(checks.some((c) => c.ok === false) ? EXIT.failed : EXIT.green);
  }
  let copy = null;
  for (const [i, name] of SCENARIO_LIST.entries()) {
    copy ??= await startCopy(i === 0 ? "copy" : `copy_${i + 1}`);
    log("scenario_start", { scenario: name, about: SCENARIOS[name].about, strategyId: copy.strategyId, account: copy.account });
    if (!(await scenarios[name](copy))) copy = null;
  }
  // --- 7. a copy still running is stopped (its return credited) ---------------------------------------------
  if (copy) await stopCheck("final", copy);

  const latency = lastReconcile?.latencySeconds ? { "signal received": lastReconcile.latencySeconds.received, "order sent": lastReconcile.latencySeconds.sent, "first follower fill": lastReconcile.latencySeconds.filled } : null;
  await finish(checks.some((c) => c.ok === false) ? EXIT.failed : EXIT.green, { latency, weightPerOrder: "n/a (the testnet bucket is not exposed by the worker)" });
} catch (error) {
  check("harness_error", false, `${error.name}: ${error.message}`);
  if (DRY && setupId) await follower?.client.post(`/me/copy/live/setups/${setupId}/cancel`).then((s) => log("dry_run_cancelled_after_error", { stage: s.stage }), () => {});
  await finish(EXIT.failed);
}
