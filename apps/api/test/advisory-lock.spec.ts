import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { ADVISORY_LOCKS, advisoryLockCollisions, advisoryLockKey, type AdvisoryLockName, type AdvisoryLockSpec } from "../src/db/advisory-lock.js";

const api = fileURLToPath(new URL("../", import.meta.url));
const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const registry: Record<string, AdvisoryLockSpec> = ADVISORY_LOCKS;

/** Every lock/unlock call in the api source (and the migration runner), as literal argument text. */
function scanCallSites(): { found: Map<string, number>; srcAcquires: number } {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mjs)$/.test(name) && !name.endsWith(".spec.ts")) files.push(path);
    }
  };
  walk(join(api, "src"));
  files.push(join(api, "scripts/migrate.mjs"));
  const found = new Map<string, number>();
  let srcAcquires = 0;
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared)?\(/g)) {
      let end = match.index + match[0].length, depth = 1;
      while (depth > 0 && end < text.length) { if (text[end] === "(") depth++; else if (text[end] === ")") depth--; end++; }
      const key = `${relative(api, path).split(sep).join("/")} | ${text.slice(match.index + match[0].length, end - 1)}`;
      found.set(key, (found.get(key) ?? 0) + 1);
      if (!match[0].includes("unlock") && key.startsWith("src/")) srcAcquires++;
    }
  }
  return { found, srcAcquires };
}

function registeredSites(): Map<string, number> {
  const sites = new Map<string, number>();
  for (const spec of Object.values(registry)) {
    for (const site of spec.sites) {
      const key = `${site.file} | ${site.args}`;
      sites.set(key, (sites.get(key) ?? 0) + (site.count ?? 1));
    }
  }
  return sites;
}

/** Sample caller input per namespace (prefixed keys take the part after the prefix). */
const samples: Record<AdvisoryLockName, [] | [number] | [string]> = {
  ACTIONS: ["0xabc"], COPY_LEADER: ["0xabc"], RISK: [], COPY_USER: [42], BOOTSTRAP: [], PLATFORM: [], REFERRAL: [],
  SETTINGS: [], MIGRATE: [], RULES: ["hl|0xabc|BTC"], WORKER: [], ANALYTICS: ["0xabc"], NOTIFY: [],
  COPY_EVENTS: ["42"], COPY_OPERATION: ["42:paper:virtual:k"], LIVE_ORDER: ["k"], LIVE_NONCE: ["mainnet:0xabc"],
  LIVE_PREPARE: ["k"], RISK_SCOPE_ACCOUNT: ["mainnet:0xabc"], RISK_SCOPE_SOURCE: ["mainnet:0xdef"], SETTLEMENT: ["k"],
  FOLLOWER_SCAN_BUDGET: ["mainnet"], WATCH_CAPACITY: [],
};
const key = (name: AdvisoryLockName) => (advisoryLockKey as (n: AdvisoryLockName, ...v: unknown[]) => SQL)(name, ...samples[name]);

/**
 * How a site's argument text renders today: `${sql.raw(String(CONST))}` inlines
 * the namespace, any other `${…}` is the next bound parameter. Raw pg-client
 * text is already rendered; its `::integer` cast does not change the key.
 */
function renderedSiteText(spec: AdvisoryLockSpec, args: string): string {
  let n = 0;
  const namespace = spec.form === "pair" ? String(spec.namespace) : "";
  return args
    .replace(/\$\{sql\.raw\(String\([A-Z_]+\)\)\}/g, namespace)
    .replace(/\$\{(?:[^{}`]|`[^`]*`|\{[^{}]*\})*\}/g, () => `$${++n}`)
    .replace(/::integer/g, "");
}

describe("advisory-lock registry", () => {
  it("has no structural collisions between namespaces", () => {
    expect(advisoryLockCollisions()).toEqual([]);
  });

  it("detects collisions in the pair and bigint key spaces", () => {
    const base = { purpose: "", scope: "xact", sites: [] } as const;
    expect(advisoryLockCollisions({
      A: { ...base, form: "pair", namespace: 73104, key: { kind: "const", value: 1 } },
      B: { ...base, form: "pair", namespace: 73104, key: { kind: "const", value: 1 } },
    })).toEqual(["A ↔ B"]);
    expect(advisoryLockCollisions({
      USER: { ...base, form: "pair", namespace: 7404, key: { kind: "int", min: 0, max: 10, source: "" } },
      BOOT: { ...base, form: "pair", namespace: 7404, key: { kind: "const", value: 0 } },
    })).toEqual(["USER ↔ BOOT"]);
    expect(advisoryLockCollisions({
      A: { ...base, form: "pair", namespace: 1, key: { kind: "hashtext", format: "" } },
      B: { ...base, form: "pair", namespace: 1, key: { kind: "const", value: 0 } },
    })).toEqual(["A ↔ B"]);
    expect(advisoryLockCollisions({
      A: { ...base, form: "hashtextextended", seed: 0, key: { kind: "prefixed", prefix: "copy-", format: "" } },
      B: { ...base, form: "hashtextextended", seed: 0, key: { kind: "prefixed", prefix: "copy-events:", format: "" } },
      C: { ...base, form: "hashtextextended", seed: 1, key: { kind: "prefixed", prefix: "copy-events:", format: "" } },
      D: { ...base, form: "hashtextextended", seed: 1, key: { kind: "const", text: "copy-events:1" } },
    })).toEqual(["A ↔ B", "C ↔ D"]);
    // Different key spaces never meet: (7404, 0) is not the bigint 7404.
    expect(advisoryLockCollisions({
      A: { ...base, form: "pair", namespace: 7404, key: { kind: "const", value: 0 } },
      B: { ...base, form: "bigint", key: { kind: "const", value: 7404 } },
    })).toEqual([]);
  });

  it("lists every advisory lock/unlock call site exactly as the code writes it", () => {
    const { found, srcAcquires } = scanCallSites();
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(registeredSites()));
    // Review §E3 #7 counts 37 acquiring calls in src; the migration runner adds one, unlocks add eight.
    expect(srcAcquires).toBe(37);
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBe(46);
  });

  it.each(Object.keys(ADVISORY_LOCKS) as AdvisoryLockName[])("%s: registered derivation renders as its call sites", (name) => {
    const spec = registry[name]!;
    const ours = render(key(name));
    for (const site of spec.sites) {
      if (site.args.includes("advisoryLockKey(")) continue; // migrated; pinned against its literal in settings.spec.ts
      expect(ours.sql, `${site.file}: ${site.args}`).toBe(renderedSiteText(spec, site.args));
      // A bound string key is the registered prefix + the caller's suffix.
      if (spec.key.kind === "prefixed" && site.args.includes("${`")) expect(site.args).toContain("${`" + spec.key.prefix + "${");
    }
  });

  it("matches the legacy drizzle templates byte for byte, parameters included", () => {
    const userId = 42, address = "0xabc", network = "mainnet", signerAddress = "0xabc", leaderAddress = "0xdef", k = "k";
    const action = { chain: "hl", address: "0xabc", coin: "BTC" };
    const ACTIONS_LOCK_NAMESPACE = 7401, COPY_LEADER_LOCK_NAMESPACE = 7402, WATCH_CAPACITY_LOCK = 4_203_401;
    const pairs: [AdvisoryLockName, SQL][] = [
      ["ACTIONS", sql`${sql.raw(String(ACTIONS_LOCK_NAMESPACE))}, hashtext(${address})`],
      ["COPY_LEADER", sql`${sql.raw(String(COPY_LEADER_LOCK_NAMESPACE))}, hashtext(${address})`],
      ["RISK", sql`7403, 0`],
      ["COPY_USER", sql`7404, ${userId}`],
      ["BOOTSTRAP", sql`7406, 0`],
      ["PLATFORM", sql`7405, 0`],
      ["REFERRAL", sql`7410, 0`],
      ["SETTINGS", sql`73104, 1`],
      ["RULES", sql`73105, hashtext(${`${action.chain}|${action.address}|${action.coin}`})`],
      ["ANALYTICS", sql`73107, hashtext(${address})`],
      ["NOTIFY", sql`hashtextextended('copy-live-notify', 0)`],
      ["COPY_EVENTS", sql`hashtextextended(${`copy-events:${userId}`}, 0)`],
      ["COPY_OPERATION", sql`hashtextextended(${`copy-operation:${userId}:paper:virtual:${k}`}, 0)`],
      ["LIVE_NONCE", sql`hashtextextended(${`live-nonce:${network}:${signerAddress}`}, 2)`],
      ["LIVE_PREPARE", sql`hashtextextended(${`live-prepare:${k}`}, 3)`],
      ["RISK_SCOPE_SOURCE", sql`hashtextextended(${`live-risk-source:${network}:${leaderAddress}`}, 8)`],
      ["FOLLOWER_SCAN_BUDGET", sql`hashtext(${`copy-follower-scan-budget:${network}`})`],
      ["WATCH_CAPACITY", sql`${WATCH_CAPACITY_LOCK}`],
    ];
    for (const [name, legacy] of pairs) expect(render(key(name)), name).toEqual(render(legacy));
    // Raw pg-client sites bind the full string as $1.
    const raw: [AdvisoryLockName, string][] = [
      ["LIVE_ORDER", `live-order:${k}`], ["RISK_SCOPE_ACCOUNT", `live-risk-account:${network}:${signerAddress}`], ["SETTLEMENT", `copy-live-settlement:${k}`],
    ];
    for (const [name, value] of raw) expect(render(key(name)).params, name).toEqual([value]);
  });

  it("gives the first-admin bootstrap a namespace of its own (G8)", () => {
    const sharing = Object.entries(registry)
      .filter(([name, spec]) => name !== "BOOTSTRAP" && spec.form === "pair" && spec.namespace === ADVISORY_LOCKS.BOOTSTRAP.namespace)
      .map(([name]) => name);
    expect(sharing).toEqual([]);
    expect(ADVISORY_LOCKS.BOOTSTRAP.namespace).not.toBe(ADVISORY_LOCKS.COPY_USER.namespace);
  });

  it("rejects keys outside the registered range", () => {
    expect(() => advisoryLockKey("COPY_USER", 0)).toThrow(/COPY_USER/);
    expect(() => advisoryLockKey("COPY_USER", 2 ** 31)).toThrow(/COPY_USER/);
  });
});
