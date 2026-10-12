#!/usr/bin/env node
// Copy harness — the local api (3100) and worker (3010) with the harness
// profile (scripts/copy-harness/harness.env over the repo-root .env).
//
//   node scripts/copy-harness/stack.mjs status
//   node scripts/copy-harness/stack.mjs restart worker|api [--profile stage-caps|ratio-floor|stage-like] [--dry-run]
//
// `--profile stage-caps` layers stage-caps.env (Stage's caps: 12–15 USD per
// trade, 50 per copy, leverage 3, 2 copies) over harness.env. Restart both
// the api and the worker with the same profile. A restart without it goes
// back to the plain harness profile. `--profile stage-like` is ratio-floor.env
// then stage-like.env: Stage's 8 ms database round trip (COPY_HARNESS_DB_RTT_MS,
// db-rtt.mjs, loaded with `node --import db-rtt.preload.mjs`).
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
import { PROFILE_FILES, ROOT, profileEnv } from "./lib.mjs";

const ROLES = { api: { port: 3100, env: { IS_WORKER: "false" } }, worker: { port: 3010, env: { IS_WORKER: "true" } } };
const args = process.argv.slice(2), [command, role] = args, dry = args.includes("--dry-run");
const profileName = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : null;
if (profileName && !PROFILE_FILES[profileName]) { console.error(`unknown --profile ${profileName} (${Object.keys(PROFILE_FILES).join(" | ")})`); process.exit(2); }
const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The PID listening on `port`, or null. */
function listener(port) {
  try { const out = execFileSync("lsof", ["-tnP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim(); return out ? Number(out.split("\n")[0]) : null; }
  catch { return null; }
}
async function healthy(port) { try { return (await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; } }

if (command === "status") {
  for (const [name, { port }] of Object.entries(ROLES)) log("status", { role: name, port, pid: listener(port), healthy: await healthy(port) });
} else if (command === "restart" && ROLES[role]) {
  const { port, env: roleEnv } = ROLES[role];
  const profile = profileEnv(profileName ?? "default");
  // TEST ONLY: a database round trip (db-rtt.mjs) for the profile that asks for it.
  const rttMs = rttFromEnv({ ...process.env, ...profile });
  const nodeArgs = rttMs > 0 ? ["--import", pathToFileURL(resolve(import.meta.dirname, "db-rtt.preload.mjs")).href] : [];
  const main = resolve(ROOT, "apps/api/dist/main.js");
  if (!existsSync(main)) throw new Error(`${main} is missing: build the api first`);
  const pid = listener(port);
  log("plan", { role, port, stopping: pid, profile: profileName ?? "harness", keys: Object.keys(profile), dbRttMs: rttMs, set: { ...roleEnv, PORT: String(port) } });
  if (dry) process.exit(0);
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 40 && listener(port); i++) await sleep(500);
    if (listener(port)) throw new Error(`PID ${pid} still holds port ${port}`);
  }
  mkdirSync(resolve(ROOT, ".claude/logs"), { recursive: true });
  const out = openSync(resolve(ROOT, `.claude/logs/${role}-${port}.log`), "a");
  const child = spawn(process.execPath, [...nodeArgs, "dist/main.js"], { cwd: resolve(ROOT, "apps/api"), env: { ...process.env, ...profile, ...roleEnv, PORT: String(port) }, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  for (let i = 0; i < 90; i++) { if (await healthy(port)) { log("started", { role, port, pid: child.pid }); process.exit(0); } await sleep(1000); }
  throw new Error(`${role} on ${port} not healthy after 90 s (see .claude/logs/${role}-${port}.log)`);
} else {
  console.error("usage: stack.mjs status | restart worker|api [--profile stage-caps|ratio-floor|stage-like] [--dry-run]");
  process.exit(2);
}
