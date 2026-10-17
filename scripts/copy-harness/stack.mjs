#!/usr/bin/env node
// Copy harness — the local api (3100) and worker (3010), and with the roles split a read worker
// (3011), with the harness profile (scripts/copy-harness/harness.env over the repo-root .env).
//
//   node scripts/copy-harness/stack.mjs status [--roles split]
//   node scripts/copy-harness/stack.mjs restart worker|worker-read|api [--profile stage-caps|ratio-floor|stage-like] [--roles all|split] [--dry-run]
//
// `--profile stage-caps` layers stage-caps.env (Stage's caps: 12–15 USD per
// trade, 50 per copy, leverage 3, 2 copies) over harness.env. Restart both
// the api and the worker with the same profile. A restart without it goes
// back to the plain harness profile. `--profile stage-like` is ratio-floor.env
// then stage-like.env: Stage's 8 ms database round trip (COPY_HARNESS_DB_RTT_MS,
// db-rtt.mjs, loaded with `node --import db-rtt.preload.mjs`).
//
// `--roles split` runs the worker as Stage does (stack-plan.mjs; apps/api/src/runtime/worker-role.ts,
// docs/worker-deployment.md «角色拆分»): `worker` is WORKER_ROLE=copy on 3010 (lease 73106,1: the live
// engine, stops, settlement, setup driver, trade feed) and `worker-read` is WORKER_ROLE=read on 3011
// (lease 73106,2: scheduler crons, traders, discovery, cohorts, leaderboard, snapshots, outbox,
// Telegram), each with /health on its port; the api gets WORKER_READ_URL so its /health merges both
// heartbeats. Order: `restart worker --roles split` first (an all-role worker holds the read lease;
// a read worker started beside it waits on standby and never turns healthy — refused here), then
// `restart worker-read --roles split`, then `restart api --roles split`. Without --roles (all) the
// one worker runs every role, as before; a `worker-read` left running then sits on standby.
//
// A restart stops the process listening on the port (by PID), starts
// `node dist/main.js` from apps/api detached (it outlives this script and the
// session), appends to .claude/logs/<role>-<port>.log and waits for /health.
// Build first when the api changed (pnpm turbo run build --filter=@trading-dashboard/api --concurrency=1).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rttFromEnv } from "./db-rtt.mjs";
import { ROOT, profileEnv } from "./lib.mjs";
import { ROLES, parseStackArgs, readWorkerBlockedBy, roleEnv, statusRoles } from "./stack-plan.mjs";

let parsed;
try { parsed = parseStackArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
const { command, role, profile: profileName, roles, dry } = parsed;
const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The PID listening on `port`, or null. */
function listener(port) {
  try { const out = execFileSync("lsof", ["-tnP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim(); return out ? Number(out.split("\n")[0]) : null; }
  catch { return null; }
}
/** The /health body of the process on `port` (a worker's heartbeat; null when not ok or not JSON). */
async function heartbeat(port) {
  try { const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json().catch(() => ({})) : null; }
  catch { return null; }
}

if (command === "status") {
  for (const { role: name, port } of statusRoles(roles)) {
    const body = await heartbeat(port);
    log("status", { role: name, port, pid: listener(port), healthy: body !== null, ...(body?.worker ? { workerRole: body.worker.role, leases: body.worker.leases } : {}) });
  }
} else {
  const { port, env: roleVars, unset, logFile } = roleEnv({ role, roles });
  const profile = profileEnv(profileName ?? "default");
  // TEST ONLY: a database round trip (db-rtt.mjs) for the profile that asks for it.
  const rttMs = rttFromEnv({ ...process.env, ...profile });
  const nodeArgs = rttMs > 0 ? ["--import", pathToFileURL(resolve(import.meta.dirname, "db-rtt.preload.mjs")).href] : [];
  const main = resolve(ROOT, "apps/api/dist/main.js");
  const pid = listener(port);
  log("plan", { role, port, roles, stopping: pid, profile: profileName ?? "harness", keys: Object.keys(profile), dbRttMs: rttMs, set: roleVars, unset, log: logFile });
  if (dry) process.exit(0);
  if (!existsSync(main)) throw new Error(`${main} is missing: build the api first`);
  // A read worker beside an all-role worker never becomes healthy (that one holds its lease): refused, with the order to follow.
  if (role === "worker-read") { const blocked = readWorkerBlockedBy(await heartbeat(ROLES.worker.port)); if (blocked) throw new Error(blocked); }
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 40 && listener(port); i++) await sleep(500);
    if (listener(port)) throw new Error(`PID ${pid} still holds port ${port}`);
  }
  mkdirSync(resolve(ROOT, ".claude/logs"), { recursive: true });
  const out = openSync(resolve(ROOT, logFile), "a");
  const env = { ...process.env, ...profile, ...roleVars };
  for (const key of unset) delete env[key];
  const child = spawn(process.execPath, [...nodeArgs, "dist/main.js"], { cwd: resolve(ROOT, "apps/api"), env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  for (let i = 0; i < 90; i++) {
    const body = await heartbeat(port);
    if (body !== null) { log("started", { role, port, pid: child.pid, ...(body.worker ? { workerRole: body.worker.role, leases: body.worker.leases } : {}) }); process.exit(0); }
    await sleep(1000);
  }
  throw new Error(`${role} on ${port} not healthy after 90 s (see ${logFile})`);
}
