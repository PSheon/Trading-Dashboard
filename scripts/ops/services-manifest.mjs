#!/usr/bin/env node
/**
 * Read-only check of a Railway environment's variable NAMES against
 * config/services.json: per service, the required names that are missing,
 * the names that must not be there (refused at startup, a secret the service
 * never uses, retired, or simply unused by that service) and the names the
 * manifest does not know.
 *
 * This script never calls Railway and never reads a value. The operator
 * lists the names (one `service<TAB>NAME` per line; `#` starts a comment) and
 * passes them on stdin or with `--names-from <file>`. Services: api,
 * worker-copy (alias: worker), worker-read, web. For example, without a
 * single value reaching the terminal:
 *
 *   for s in api worker worker-read web; do
 *     railway variables --service "$s" --json \
 *       | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{for(const k of Object.keys(JSON.parse(t)))console.log(process.argv[1]+"\t"+k)})' "$s"
 *   done > /tmp/railway-names.tsv
 *   node scripts/ops/services-manifest.mjs --names-from /tmp/railway-names.tsv
 *
 * Options: --names-from <file> (default: stdin), --manifest <path> (default
 * config/services.json), --json (the report as JSON instead of text).
 * Exit 1 when any service has a finding, 0 when every service is clean.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SERVICES = ["api", "worker-copy", "worker-read", "web"];
const SERVICE_ALIASES = { worker: "worker-copy" };
export const STATUSES = ["required", "optional"];

const here = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_MANIFEST_PATH = resolve(here, "../../config/services.json");

export function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Whether `name` is one of the manifest's platform names (`PREFIX_*` matches a prefix). */
export function isPlatformName(manifest, name) {
  return Object.keys(manifest.platform ?? {}).some((pattern) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name);
}

/** `service<TAB>NAME` lines → Map of service → Set of names. Unknown services and malformed lines throw. */
export function parseNames(text) {
  const byService = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\t|\s+/).filter(Boolean);
    if (parts.length !== 2) throw new Error(`line ${i + 1}: expected \`service<TAB>NAME\`, got ${JSON.stringify(lines[i])}`);
    const service = SERVICE_ALIASES[parts[0]] ?? parts[0];
    if (!SERVICES.includes(service)) throw new Error(`line ${i + 1}: unknown service ${JSON.stringify(parts[0])} (one of ${SERVICES.join(", ")}, or worker)`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(parts[1])) throw new Error(`line ${i + 1}: ${JSON.stringify(parts[1])} is not a variable name`);
    if (!byService.has(service)) byService.set(service, new Set());
    byService.get(service).add(parts[1]);
  }
  return byService;
}

/** What one service's status for `name` is: required | optional | { forbidden, reason } | null (unknown). */
export function statusOf(manifest, service, name) {
  if (manifest.retired && name in manifest.retired) return { forbidden: "retired", reason: manifest.retired[name] };
  const variable = manifest.variables[name];
  if (!variable) return null;
  const status = variable.services?.[service];
  if (status) return status;
  const reason = variable.forbidden?.[service];
  if (reason) return { forbidden: reason.match(/^(refused|secret|unused)/)?.[1] ?? "forbidden", reason };
  return { forbidden: "unused", reason: `not used by ${service}` };
}

/** Per service: missing required names, present forbidden names (with the reason) and names the manifest does not know. */
export function evaluate(manifest, namesByService) {
  const report = {};
  for (const service of SERVICES) {
    if (!namesByService.has(service)) continue;
    const present = namesByService.get(service);
    const missingRequired = Object.entries(manifest.variables)
      .filter(([name, variable]) => variable.services?.[service] === "required" && !present.has(name))
      .map(([name]) => name).sort();
    const forbidden = [], unknown = [];
    for (const name of [...present].sort()) {
      if (isPlatformName(manifest, name)) continue;
      const status = statusOf(manifest, service, name);
      if (status === null) unknown.push(name);
      else if (typeof status === "object") forbidden.push({ name, kind: status.forbidden, reason: status.reason });
    }
    report[service] = { present: present.size, missingRequired, forbidden, unknown };
  }
  return report;
}

export function hasFindings(report) {
  return Object.values(report).some((s) => s.missingRequired.length || s.forbidden.length || s.unknown.length);
}

export function render(report) {
  const lines = [];
  for (const [service, s] of Object.entries(report)) {
    const clean = !s.missingRequired.length && !s.forbidden.length && !s.unknown.length;
    lines.push(`${service} (${s.present} names)${clean ? ": ok" : ""}`);
    for (const name of s.missingRequired) lines.push(`  missing required  ${name}`);
    for (const f of s.forbidden) lines.push(`  present forbidden ${f.name}  [${f.kind}] ${f.reason}`);
    for (const name of s.unknown) lines.push(`  unknown           ${name}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--names-from" || arg === "--manifest") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      out[arg === "--names-from" ? "namesFrom" : "manifest"] = value;
    } else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const manifest = loadManifest(args.manifest ? resolve(args.manifest) : DEFAULT_MANIFEST_PATH);
  const text = args.namesFrom ? readFileSync(resolve(args.namesFrom), "utf8") : readFileSync(0, "utf8");
  const namesByService = parseNames(text);
  if (!namesByService.size) throw new Error("no `service<TAB>NAME` lines read");
  const report = evaluate(manifest, namesByService);
  console.log(args.json ? JSON.stringify(report, null, 2) : render(report));
  return hasFindings(report) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
