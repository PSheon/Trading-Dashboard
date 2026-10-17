// Copy harness — the local stack's plan (pure; stack.test.mjs): which process each role is, its port,
// the environment it gets, and how `--roles split` turns the one all-role worker into Stage's pair
// (a copy worker and a read worker; apps/api/src/runtime/worker-role.ts, docs/worker-deployment.md).
// Nothing here starts a process or reads a secret.
import { PROFILE_FILES } from "./lib.mjs";

/**
 * The processes stack.mjs manages, each `node dist/main.js` from apps/api with its own port:
 *   api          IS_WORKER=false on 3100;
 *   worker       IS_WORKER=true on 3010: with --roles all (default) WORKER_ROLE unset, the all-role
 *                worker that holds both leases (73106,1) and (73106,2); with --roles split WORKER_ROLE=copy
 *                (lease 1: the live engine, stops, settlement, the setup driver, the trade feed);
 *   worker-read  IS_WORKER=true WORKER_ROLE=read on 3011 (lease 2: scheduler crons, traders, discovery,
 *                cohorts, leaderboard, snapshots, outbox, Telegram…); only exists when the roles are split.
 * The worker's port is given as PORT and WORKER_PORT (runtime-config: WORKER_PORT wins for a worker,
 * and the root .env may set it), so the read worker never lands on the copy worker's port.
 */
export const ROLES = Object.freeze({
  api: { port: 3100, env: { IS_WORKER: "false" } },
  worker: { port: 3010, env: { IS_WORKER: "true" } },
  "worker-read": { port: 3011, env: { IS_WORKER: "true", WORKER_ROLE: "read" }, splitOnly: true },
});
/** `--roles all`: one all-role worker (today's default); `--roles split`: a copy worker and a read worker, as on Stage. */
export const WORKER_ROLES_MODES = Object.freeze(["all", "split"]);

/**
 * stack.mjs's arguments: `status | restart <role>`, `--profile`, `--roles all|split`, `--dry-run`.
 * Throws a usage error (message) for an unknown profile, roles mode or role.
 * @param {string[]} argv
 */
export function parseStackArgs(argv) {
  const positional = [], flags = { profile: null, roles: "all", dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dry = true;
    else if (a === "--profile" || a === "--roles") { flags[a.slice(2)] = argv[++i] ?? ""; }
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  const [command, role] = positional, { profile, roles, dry } = flags;
  if (profile !== null && !PROFILE_FILES[profile]) throw new Error(`unknown --profile ${profile} (${Object.keys(PROFILE_FILES).join(" | ")})`);
  if (!WORKER_ROLES_MODES.includes(roles)) throw new Error(`unknown --roles ${roles} (${WORKER_ROLES_MODES.join(" | ")})`);
  if (command === "restart" && !ROLES[role]) throw new Error(`restart: a role (${Object.keys(ROLES).join(" | ")})`);
  if (command === "restart" && ROLES[role].splitOnly && roles !== "split") throw new Error(`${role} runs only with --roles split (restart worker --roles split first: an all-role worker holds its lease)`);
  if (!["status", "restart"].includes(command)) throw new Error("usage: stack.mjs status | restart worker|worker-read|api [--profile stage-caps|ratio-floor|stage-like] [--roles all|split] [--dry-run]");
  return { command, role: command === "restart" ? role : null, profile, roles, dry };
}

/**
 * The environment a role's process gets on top of the process's own and the profile's: its port (the
 * worker roles also as WORKER_PORT), IS_WORKER, and the roles' variables — split: the worker is
 * WORKER_ROLE=copy, the read worker WORKER_ROLE=read, and the api gets WORKER_READ_URL (its /health
 * merges both heartbeats; WorkerFleetService); all: no WORKER_ROLE (the api refuses one, and an unset
 * one on the worker is `all`). `unset`: variables the spawned environment must not carry over from the
 * parent (a WORKER_ROLE left in the shell would make an all-role worker a copy one, or stop the api).
 * @param {{ role: keyof typeof ROLES, roles: "all" | "split", host?: string }} plan
 */
export function roleEnv({ role, roles, host = "localhost" }) {
  const def = ROLES[role];
  if (!def) throw new Error(`unknown role ${role}`);
  const port = String(def.port);
  const env = { ...def.env, PORT: port, ...(def.env.IS_WORKER === "true" ? { WORKER_PORT: port } : {}) };
  const unset = ["WORKER_ROLE", "WORKER_READ_URL"];
  if (roles === "split") {
    if (role === "worker") env.WORKER_ROLE = "copy";
    if (role === "api") env.WORKER_READ_URL = `http://${host}:${ROLES["worker-read"].port}`;
  }
  return { port: def.port, env, unset: unset.filter((k) => !(k in env)), logFile: `.claude/logs/${role}-${def.port}.log` };
}

/** The roles `status` lists for a roles mode (the read worker only when split). */
export function statusRoles(roles = "all") {
  return Object.entries(ROLES).filter(([, def]) => roles === "split" || !def.splitOnly).map(([name, def]) => ({ role: name, port: def.port }));
}

/**
 * Whether a `worker-read` may start now, from the copy-port worker's heartbeat (its `worker.role`):
 * an `all` worker there holds lease (73106,2), so the read worker would sit on standby and never
 * become healthy. `null` heartbeat (no worker up, or no role in it): nothing is known, start it.
 * @param {{ worker?: { role?: string } } | null} heartbeat
 */
export function readWorkerBlockedBy(heartbeat) {
  const role = heartbeat?.worker?.role ?? null;
  return role === "all" ? "the worker on the copy port runs as `all` and holds the read lease: restart it with --roles split first" : null;
}
