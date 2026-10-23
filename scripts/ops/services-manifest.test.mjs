import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MANIFEST_PATH, SERVICES, evaluate, hasFindings, isPlatformName, loadManifest, parseNames, render, statusOf } from "./services-manifest.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const manifest = loadManifest();
const STATUSES = ["required", "optional"];

/** Every file under `dir` (recursively) whose name passes `keep`. */
function filesUnder(dir, keep) {
  const out = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const path = join(dir, entry);
    if (statSync(path).isFile() && keep(entry)) out.push(path);
  }
  return out;
}

const isRuntimeTs = (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".d.ts");
/** Where a manifest name must be read: the api's runtime sources, the web's sources and configs, the image and the Railway config. */
const CODE_FILES = [
  ...filesUnder(join(root, "apps/api/src"), isRuntimeTs),
  ...filesUnder(join(root, "apps/web/src"), (name) => /\.(ts|tsx|mjs)$/.test(name) && !/\.(spec|test)\./.test(name)),
  join(root, "apps/web/next.config.ts"),
  join(root, "apps/web/playwright.config.ts"),
  join(root, "apps/web/scripts/dev.mjs"),
  join(root, "apps/api/Dockerfile"),
  join(root, "apps/api/railway.json"),
];
const code = CODE_FILES.map((path) => readFileSync(path, "utf8")).join("\n");

/** A read of `name`: `process.env.NAME`, `source.NAME`, `source["NAME"]`, or the name as a string literal (the key passed to a parser). */
function readsName(text, name) {
  return new RegExp(`(?:process\\.env\\.|source\\.|source\\[["'])${name}\\b|["']${name}["']`).test(text);
}

/** The env reads runtime-config.ts makes, directly or through the helpers it hands `source` to. */
const RUNTIME_CONFIG_FILES = ["apps/api/src/config/runtime-config.ts", "apps/api/src/config/live-timings.ts", "apps/api/src/runtime/worker-role.ts"];
function runtimeConfigReads() {
  const names = new Set();
  for (const file of RUNTIME_CONFIG_FILES) {
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(/(?:source|process\.env)(?:\.|\[["'])([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
    // `const key = "NAME", raw = source[key]`.
    for (const match of text.matchAll(/key = "([A-Z][A-Z0-9_]*)"/g)) names.add(match[1]);
  }
  return names;
}

test("manifest: well formed (services, statuses, sameAs, forbidden, retired, platform)", () => {
  assert.deepEqual(Object.keys(manifest.services).sort(), [...SERVICES].sort());
  for (const [name, variable] of Object.entries(manifest.variables)) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${name}: not a variable name`);
    assert.equal(typeof variable.purpose, "string", `${name}: purpose missing`);
    assert.ok(variable.purpose.length > 0 && !variable.purpose.includes("\n"), `${name}: purpose must be one line`);
    assert.ok(variable.services && typeof variable.services === "object", `${name}: services missing`);
    for (const [service, status] of Object.entries(variable.services)) {
      assert.ok(SERVICES.includes(service), `${name}: unknown service ${service}`);
      assert.ok(STATUSES.includes(status), `${name}.${service}: status ${status}`);
      assert.ok(!variable.forbidden?.[service], `${name}: ${service} is both listed and forbidden`);
    }
    for (const [service, reason] of Object.entries(variable.forbidden ?? {})) {
      assert.ok(SERVICES.includes(service), `${name}.forbidden: unknown service ${service}`);
      assert.match(reason, /^(refused|secret|unused)\b/, `${name}.forbidden.${service}: reason must start with refused, secret or unused`);
    }
    for (const service of variable.sameAs ?? []) {
      assert.ok(variable.services[service], `${name}.sameAs: ${service} does not use it`);
    }
    if (variable.sameAs) assert.ok(variable.sameAs.length >= 2, `${name}.sameAs needs two services`);
    assert.ok(!(name in manifest.retired), `${name}: both a variable and retired`);
    assert.ok(!isPlatformName(manifest, name), `${name}: both a variable and a platform name`);
    assert.ok(Object.keys(variable.services).length || Object.keys(variable.forbidden ?? {}).length, `${name}: used nowhere and forbidden nowhere`);
  }
  for (const [name, reason] of Object.entries(manifest.retired)) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(typeof reason, "string");
  }
  for (const [pattern, reason] of Object.entries(manifest.platform)) {
    assert.match(pattern, /^[A-Z][A-Z0-9_]*\*?$/, `platform ${pattern}`);
    assert.equal(typeof reason, "string");
  }
});

test("manifest: every service has at least one required variable", () => {
  for (const service of SERVICES) {
    const required = Object.values(manifest.variables).filter((v) => v.services[service] === "required");
    assert.ok(required.length > 0, `${service} has no required variable`);
  }
});

test("manifest: every variable name is read somewhere in the code", () => {
  const unread = Object.keys(manifest.variables).filter((name) => !readsName(code, name));
  assert.deepEqual(unread, [], `manifest names no code reads: ${unread.join(", ")}`);
});

test("manifest: every environment read in runtime-config.ts is in the manifest (or retired, or a platform name)", () => {
  const missing = [...runtimeConfigReads()].filter((name) => !(name in manifest.variables) && !(name in manifest.retired) && !isPlatformName(manifest, name)).sort();
  assert.deepEqual(missing, [], `runtime-config.ts reads these names the manifest does not list: ${missing.join(", ")}`);
});

test("manifest: names that must agree across services are the ones the code ties together", () => {
  const same = (name) => manifest.variables[name].sameAs ?? [];
  assert.deepEqual(same("HYPERLIQUID_EGRESS_KEY"), ["api", "worker-copy", "worker-read"]);
  assert.deepEqual(same("DATABASE_URL"), ["api", "worker-copy", "worker-read"]);
  assert.deepEqual(same("HYPERLIQUID_NETWORK"), ["api", "worker-copy", "worker-read"]);
  assert.ok(same("COPY_TRADING_MODE").includes("api") && same("COPY_TRADING_MODE").includes("worker-copy"));
});

test("manifest: the startup refusals runtime-config.ts enforces are forbidden where it refuses them", () => {
  const forbidden = (name, service) => statusOf(manifest, service, name);
  assert.equal(forbidden("HYPERLIQUID_READ_METER", "api").forbidden, "refused");
  assert.equal(forbidden("HYPERLIQUID_READ_METER", "worker-copy").forbidden, "refused");
  assert.equal(forbidden("HYPERLIQUID_READ_METER", "worker-read"), "optional");
  assert.equal(forbidden("HYPERLIQUID_BACKGROUND_REST_CAP", "worker-read").forbidden, "refused");
  assert.equal(forbidden("WORKER_ROLE", "api").forbidden, "refused");
  // The Privy variables are read only by the processes that sign or verify with them (runtime-config.ts `signs`).
  for (const name of ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_AGENT_AUTHORIZATION_KEY", "PRIVY_AGENT_WORKER_QUORUM_ID"]) {
    assert.equal(forbidden(name, "worker-read").forbidden, "secret", `${name} on worker-read`);
    assert.equal(forbidden(name, "api"), "required", `${name} on api`);
    assert.equal(forbidden(name, "worker-copy"), "required", `${name} on worker-copy`);
    assert.deepEqual(manifest.variables[name].sameAs, ["api", "worker-copy"], `${name}.sameAs`);
  }
  assert.equal(forbidden("PRIVY_VERIFICATION_KEY", "worker-read").forbidden, "unused");
  for (const service of ["api", "worker-copy", "worker-read"]) {
    assert.equal(forbidden("COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS", service).forbidden, "refused");
    assert.equal(forbidden("APP_ROLE", service).forbidden, "retired");
    assert.equal(forbidden("COPY_LIVE_TEST_MIN_FLOOR_MAX_USD", service).forbidden, "retired");
  }
});

// --- the checker -----------------------------------------------------------

const FIXTURE = `# Railway names, one service<TAB>NAME per line
api\tNODE_ENV
api\tDATABASE_URL
api\tHYPERLIQUID_EGRESS_KEY
api\tHYPERLIQUID_NETWORK
api\tCOPY_TRADING_MODE
api\tCOPY_LIVE_ALLOWED_PRIVY_USER_IDS
api\tPRIVY_APP_ID
api\tPRIVY_APP_SECRET
api\tPRIVY_AGENT_AUTHORIZATION_KEY
api\tPRIVY_AGENT_WORKER_QUORUM_ID
api\tWORKER_URL
api\tPORT
api\tRAILWAY_SERVICE_ID
api\tHYPERLIQUID_READ_METER
api\tAWS_ACCESS_KEY_ID
api\tCOPY_LIVE_TEST_MIN_FLOOR_MAX_USD
api\tTOTALLY_NEW_NAME
worker\tIS_WORKER
worker\tWORKER_ROLE
worker\tNODE_ENV
worker\tDATABASE_URL
worker\tHYPERLIQUID_EGRESS_KEY
worker\tHYPERLIQUID_NETWORK
worker\tCOPY_TRADING_MODE
worker\tCOPY_LIVE_ALLOWED_PRIVY_USER_IDS
worker\tPRIVY_APP_ID
worker\tPRIVY_APP_SECRET
worker\tPRIVY_AGENT_AUTHORIZATION_KEY
worker\tPRIVY_AGENT_WORKER_QUORUM_ID
worker\tAPI_CORS_ORIGINS
worker-read\tIS_WORKER
worker-read\tWORKER_ROLE
worker-read\tNODE_ENV
worker-read\tDATABASE_URL
worker-read\tHYPERLIQUID_EGRESS_KEY
worker-read\tHYPERLIQUID_BACKGROUND_REST_CAP
web\tNEXT_API_URL
web\tNEXT_PUBLIC_PRIVY_APP_ID
web\tDATABASE_URL
`;

test("checker: parses service<TAB>NAME lines, the worker alias and comments; refuses junk", () => {
  const names = parseNames(FIXTURE);
  assert.ok(names.get("api").has("DATABASE_URL"));
  assert.ok(names.get("worker-copy").has("WORKER_ROLE"), "`worker` is worker-copy");
  assert.equal(names.get("web").size, 3);
  assert.throws(() => parseNames("db\tDATABASE_URL"), /unknown service/);
  assert.throws(() => parseNames("api\tdatabase_url"), /not a variable name/);
  assert.throws(() => parseNames("api DATABASE_URL extra"), /expected/);
  assert.throws(() => parseNames("api\tDATABASE_URL=postgres://x"), /not a variable name/);
});

test("checker: reports missing required, present forbidden (by kind) and unknown names per service", () => {
  const report = evaluate(manifest, parseNames(FIXTURE));
  assert.deepEqual(Object.keys(report), ["api", "worker-copy", "worker-read", "web"]);

  const api = report.api;
  assert.deepEqual(api.missingRequired, []);
  assert.deepEqual(api.unknown, ["TOTALLY_NEW_NAME"]);
  assert.deepEqual(api.forbidden.map((f) => [f.name, f.kind]), [
    ["AWS_ACCESS_KEY_ID", "secret"],
    ["COPY_LIVE_TEST_MIN_FLOOR_MAX_USD", "retired"],
    ["HYPERLIQUID_READ_METER", "refused"],
  ]);
  assert.equal(api.present, 17, "platform names count as present but are never findings");

  const copy = report["worker-copy"];
  assert.deepEqual(copy.missingRequired, []);
  assert.deepEqual(copy.forbidden.map((f) => [f.name, f.kind]), [["API_CORS_ORIGINS", "unused"]]);

  const read = report["worker-read"];
  assert.deepEqual(read.missingRequired, ["HYPERLIQUID_NETWORK"]);
  assert.deepEqual(read.forbidden.map((f) => [f.name, f.kind]), [["HYPERLIQUID_BACKGROUND_REST_CAP", "refused"]]);

  const web = report.web;
  assert.deepEqual(web.missingRequired, ["NEXT_PUBLIC_APP_URL"]);
  assert.deepEqual(web.forbidden.map((f) => [f.name, f.kind]), [["DATABASE_URL", "secret"]]);
  assert.ok(hasFindings(report));
});

test("checker: a clean service renders as ok and a clean report has no findings", () => {
  const clean = evaluate(manifest, parseNames("web\tNEXT_API_URL\nweb\tNEXT_PUBLIC_APP_URL\nweb\tNEXT_PUBLIC_PRIVY_APP_ID\nweb\tNODE_ENV\nweb\tPORT\n"));
  assert.deepEqual(clean, { web: { present: 5, missingRequired: [], forbidden: [], unknown: [] } });
  assert.equal(hasFindings(clean), false);
  assert.equal(render(clean), "web (5 names): ok");
  const text = render(evaluate(manifest, parseNames(FIXTURE)));
  assert.match(text, /^api \(17 names\)\n  present forbidden AWS_ACCESS_KEY_ID {2}\[secret\]/);
  assert.match(text, /\n  unknown {11}TOTALLY_NEW_NAME\n/);
  assert.match(text, /\nworker-read \(6 names\)\n  missing required {2}HYPERLIQUID_NETWORK\n/);
});

test("checker CLI: --names-from, exit 1 on findings, 0 when clean, never prints a value", () => {
  const dir = mkdtempSync(join(tmpdir(), "services-manifest-"));
  const script = join(root, "scripts/ops/services-manifest.mjs");
  const findings = join(dir, "findings.tsv");
  writeFileSync(findings, FIXTURE);
  const run = (args, input) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }) };
    } catch (error) { return { code: error.status, out: error.stdout, err: error.stderr }; }
  };
  const bad = run(["--names-from", findings]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /unknown {11}TOTALLY_NEW_NAME/);
  const json = run(["--names-from", findings, "--json"]);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.out).web.missingRequired, ["NEXT_PUBLIC_APP_URL"]);
  const clean = run([], "web\tNEXT_API_URL\nweb\tNEXT_PUBLIC_APP_URL\nweb\tNEXT_PUBLIC_PRIVY_APP_ID\n");
  assert.equal(clean.code, 0);
  assert.equal(clean.out.trim(), "web (3 names): ok");
  const empty = run([], "# nothing\n");
  assert.equal(empty.code, 2);
  assert.match(empty.err, /no `service<TAB>NAME` lines read/);
  const other = run(["--manifest", DEFAULT_MANIFEST_PATH, "--bogus"]);
  assert.equal(other.code, 2);
});
