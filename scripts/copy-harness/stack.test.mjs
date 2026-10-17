// stack.mjs's plan (stack-plan.mjs): the roles, their ports and environment, `--roles split` (a copy
// worker and a read worker, as on Stage) and the dry run of the script itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { ROLES, WORKER_ROLES_MODES, parseStackArgs, readWorkerBlockedBy, roleEnv, statusRoles } from "./stack-plan.mjs";

test("parseStackArgs: status | restart <role>, the profile, the roles mode, the dry run; usage errors", () => {
  assert.deepEqual(parseStackArgs(["status"]), { command: "status", role: null, profile: null, roles: "all", dry: false });
  assert.deepEqual(parseStackArgs(["restart", "worker"]), { command: "restart", role: "worker", profile: null, roles: "all", dry: false });
  assert.deepEqual(parseStackArgs(["restart", "worker", "--profile", "stage-like", "--roles", "split", "--dry-run"]), { command: "restart", role: "worker", profile: "stage-like", roles: "split", dry: true });
  assert.deepEqual(parseStackArgs(["restart", "worker-read", "--roles", "split"]), { command: "restart", role: "worker-read", profile: null, roles: "split", dry: false });
  assert.deepEqual(parseStackArgs(["--roles", "split", "status"]).roles, "split");
  assert.throws(() => parseStackArgs(["restart", "worker-read"]), /worker-read runs only with --roles split/);
  assert.throws(() => parseStackArgs(["restart", "db"]), /restart: a role \(api \| worker \| worker-read\)/);
  assert.throws(() => parseStackArgs(["restart", "worker", "--roles", "both"]), /unknown --roles both \(all \| split\)/);
  assert.throws(() => parseStackArgs(["restart", "worker", "--profile", "mainnet"]), /unknown --profile mainnet/);
  assert.throws(() => parseStackArgs(["restart", "worker", "--headed"]), /unknown flag --headed/);
  assert.throws(() => parseStackArgs([]), /usage: stack\.mjs status \| restart worker\|worker-read\|api/);
  assert.deepEqual(WORKER_ROLES_MODES, ["all", "split"]);
});

test("roleEnv: each role's port and variables; split makes the worker copy, the read worker read, and tells the api where the read worker is", () => {
  assert.deepEqual(roleEnv({ role: "api", roles: "all" }), { port: 3100, env: { IS_WORKER: "false", PORT: "3100" }, unset: ["WORKER_ROLE", "WORKER_READ_URL"], logFile: ".claude/logs/api-3100.log" });
  // The all-role worker: no WORKER_ROLE at all (unset is `all`; one left in the shell is removed), and WORKER_PORT beside PORT (runtime-config: WORKER_PORT wins for a worker).
  assert.deepEqual(roleEnv({ role: "worker", roles: "all" }), { port: 3010, env: { IS_WORKER: "true", PORT: "3010", WORKER_PORT: "3010" }, unset: ["WORKER_ROLE", "WORKER_READ_URL"], logFile: ".claude/logs/worker-3010.log" });
  assert.deepEqual(roleEnv({ role: "worker", roles: "split" }), { port: 3010, env: { IS_WORKER: "true", PORT: "3010", WORKER_PORT: "3010", WORKER_ROLE: "copy" }, unset: ["WORKER_READ_URL"], logFile: ".claude/logs/worker-3010.log" });
  assert.deepEqual(roleEnv({ role: "worker-read", roles: "split" }), { port: 3011, env: { IS_WORKER: "true", WORKER_ROLE: "read", PORT: "3011", WORKER_PORT: "3011" }, unset: ["WORKER_READ_URL"], logFile: ".claude/logs/worker-read-3011.log" });
  assert.deepEqual(roleEnv({ role: "api", roles: "split" }).env, { IS_WORKER: "false", PORT: "3100", WORKER_READ_URL: "http://localhost:3011" });
  assert.deepEqual(roleEnv({ role: "api", roles: "split" }).unset, ["WORKER_ROLE"]);
  assert.notEqual(ROLES.worker.port, ROLES["worker-read"].port);
  assert.throws(() => roleEnv({ role: "web", roles: "all" }), /unknown role web/);
});

test("statusRoles and readWorkerBlockedBy: the read worker is listed only when split, and refused beside an all-role worker", () => {
  assert.deepEqual(statusRoles(), [{ role: "api", port: 3100 }, { role: "worker", port: 3010 }]);
  assert.deepEqual(statusRoles("split").map((r) => r.role), ["api", "worker", "worker-read"]);
  assert.match(readWorkerBlockedBy({ worker: { role: "all", leases: [1, 2] } }), /runs as `all` and holds the read lease: restart it with --roles split first/);
  assert.equal(readWorkerBlockedBy({ worker: { role: "copy", leases: [1] } }), null);
  assert.equal(readWorkerBlockedBy(null), null);
  assert.equal(readWorkerBlockedBy({}), null);
});

test("stack.mjs --dry-run: the plan names the role, port, roles and the variables set and unset, and starts nothing", () => {
  const run = (...args) => spawnSync(process.execPath, [new URL("./stack.mjs", import.meta.url).pathname, ...args], { encoding: "utf8", env: { ...process.env, WORKER_ROLE: "copy" } });
  const plan = (r) => JSON.parse(r.stdout.trim().split("\n").find((l) => l.includes('"event":"plan"')));
  const read = run("restart", "worker-read", "--roles", "split", "--profile", "stage-like", "--dry-run");
  assert.equal(read.status, 0, read.stderr);
  const p = plan(read);
  assert.equal(p.role, "worker-read"); assert.equal(p.port, 3011); assert.equal(p.roles, "split"); assert.equal(p.profile, "stage-like"); assert.equal(p.dbRttMs, 8);
  assert.deepEqual(p.set, { IS_WORKER: "true", WORKER_ROLE: "read", PORT: "3011", WORKER_PORT: "3011" });
  assert.equal(p.log, ".claude/logs/worker-read-3011.log");
  const worker = plan(run("restart", "worker", "--dry-run"));
  assert.equal(worker.set.WORKER_ROLE, undefined, "an all-role worker gets no WORKER_ROLE");
  assert.deepEqual(worker.unset, ["WORKER_ROLE", "WORKER_READ_URL"], "and one in the shell is dropped");
  assert.equal(plan(run("restart", "worker", "--roles", "split", "--dry-run")).set.WORKER_ROLE, "copy");
  assert.equal(plan(run("restart", "api", "--roles", "split", "--dry-run")).set.WORKER_READ_URL, "http://localhost:3011");
  // Usage errors exit 2 before anything is planned.
  const bad = run("restart", "worker-read", "--dry-run");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /worker-read runs only with --roles split/);
  assert.equal(run("restart", "worker", "--roles", "both", "--dry-run").status, 2);
});
