import { sql, type SQL } from "drizzle-orm";

/**
 * Registry of every Postgres advisory-lock namespace this repo uses.
 *
 * Postgres has two disjoint advisory key spaces (pg_locks.objsubid):
 * - `pair`: `pg_advisory_*(int4, int4)`, objsubid = 2. Identity is (namespace, key).
 * - one bigint, objsubid = 1: `hashtextextended(text, seed)`, `hashtext(text)`
 *   (int4, sign-extended) and plain bigint constants all land here. Distinct
 *   strings can only meet by hash chance; the registry rules out the
 *   structural overlaps (same seed with overlapping key strings).
 *
 * Each entry documents the key derivation exactly as the call sites write it
 * today, and `sites` lists the literal argument text of every lock/unlock call
 * (test/advisory-lock.spec.ts scans the source and fails on any drift). Lock
 * identity is what matters across processes: old and new code must derive the
 * same key, so a migration onto `advisoryLockKey` has to render the same SQL.
 *
 * Only settings.repository.ts uses `advisoryLockKey` so far; the remaining
 * callers must move in one deploy (old and new processes never run mixed).
 */

type Site = {
  /** Path relative to apps/api. */
  readonly file: string;
  /** Exact text between the parentheses of the lock/unlock call. */
  readonly args: string;
  /** How many calls in the file use exactly these arguments. */
  readonly count?: number;
};

type Common = {
  readonly purpose: string;
  /** `xact` = transaction-scoped; `session` = held on a dedicated connection until unlocked. */
  readonly scope: "xact" | "session";
  readonly sites: readonly Site[];
};

export type AdvisoryLockSpec = Common & (
  /** `<namespace>, <value>` — fixed key. */
  | { readonly form: "pair"; readonly namespace: number; readonly key: { readonly kind: "const"; readonly value: number } }
  /** `<namespace>, ${int}` — caller integer bound as a parameter. */
  | { readonly form: "pair"; readonly namespace: number; readonly key: { readonly kind: "int"; readonly min: number; readonly max: number; readonly source: string } }
  /** `<namespace>, hashtext(${text})`. */
  | { readonly form: "pair"; readonly namespace: number; readonly key: { readonly kind: "hashtext"; readonly format: string } }
  /** `hashtextextended('<text>', <seed>)` — constant string inlined as a literal. */
  | { readonly form: "hashtextextended"; readonly seed: number; readonly key: { readonly kind: "const"; readonly text: string } }
  /** `hashtextextended(${prefix + suffix}, <seed>)` — whole string bound as one parameter. */
  | { readonly form: "hashtextextended"; readonly seed: number; readonly key: { readonly kind: "prefixed"; readonly prefix: string; readonly format: string } }
  /** `hashtext(${prefix + suffix})` as the single bigint argument. */
  | { readonly form: "hashtext"; readonly key: { readonly kind: "prefixed"; readonly prefix: string; readonly format: string } }
  /** `${value}` — bigint constant bound as a parameter. */
  | { readonly form: "bigint"; readonly key: { readonly kind: "const"; readonly value: number } }
);

const INT4_MAX = 2_147_483_647;

export const ADVISORY_LOCKS = {
  // ---- pair form (objsubid = 2) -------------------------------------------
  ACTIONS: {
    purpose: "Per-leader action ingest (feed fast path and fill sync).",
    scope: "xact", form: "pair", namespace: 7401, key: { kind: "hashtext", format: "<address>" },
    sites: [{ file: "src/watcher/action-store.ts", args: "${sql.raw(String(ACTIONS_LOCK_NAMESPACE))}, hashtext(${address})" }],
  },
  COPY_LEADER: {
    purpose: "Per-leader copy outbox enqueue.",
    scope: "xact", form: "pair", namespace: 7402, key: { kind: "hashtext", format: "<address>" },
    sites: [{ file: "src/copy/copy-outbox.ts", args: "${sql.raw(String(COPY_LEADER_LOCK_NAMESPACE))}, hashtext(${address})" }],
  },
  RISK: {
    purpose: "Copy risk policy: exclusive for policy edits, shared for execution and live admission.",
    scope: "xact", form: "pair", namespace: 7403, key: { kind: "const", value: 0 },
    sites: [
      { file: "src/copy/copy.repository.ts", args: "7403, 0", count: 2 },
      { file: "src/copy/copy-live-mandate.repository.ts", args: "7403, 0" },
      { file: "src/copy/live-worker/copy-live-stop-worker.repository.ts", args: "7403, 0" },
      { file: "src/copy/live-worker/copy-live-worker.repository.ts", args: "7403, 0" },
      // Session-scoped try/unlock on the risk-scope connection.
      { file: "src/copy/live/postgres-live-risk-scope.ts", args: "7403, 0", count: 2 },
    ],
  },
  COPY_USER: {
    purpose: "Per-user copy risk/money writers and controls.",
    scope: "xact", form: "pair", namespace: 7404, key: { kind: "int", min: 1, max: INT4_MAX, source: "users.id (serial, starts at 1)" },
    sites: [
      { file: "src/copy/copy-user-lock.ts", args: "7404, ${userId}" },
      { file: "src/copy/copy.repository.ts", args: "7404, ${userId}", count: 2 },
      { file: "src/copy/copy-account-mode.repository.ts", args: "7404, ${userId}" },
      // Raw pg client: same key, explicit int4 cast on the parameter.
      { file: "src/copy/live/postgres-live-risk-scope.ts", args: "7404, $1::integer", count: 2 },
    ],
  },
  /** Own namespace (was (7404, 0) inside COPY_USER's space until G8, 2026-10-12). */
  BOOTSTRAP: {
    purpose: "First-admin bootstrap.",
    scope: "xact", form: "pair", namespace: 7406, key: { kind: "const", value: 0 },
    sites: [{ file: "src/common/auth/auth.repository.ts", args: "7406, 0" }],
  },
  PLATFORM: {
    purpose: "Platform copy control (stop) and live authority settings.",
    scope: "xact", form: "pair", namespace: 7405, key: { kind: "const", value: 0 },
    sites: [
      { file: "src/copy/copy-user-lock.ts", args: "7405, 0" },
      { file: "src/copy/copy.repository.ts", args: "7405, 0" },
      { file: "src/copy/copy-live-mandate.repository.ts", args: "7405, 0" },
      { file: "src/copy/live-worker/copy-live-stop-worker.repository.ts", args: "7405, 0" },
      { file: "src/copy/live-worker/copy-live-worker.repository.ts", args: "7405, 0" },
      { file: "src/copy/live/postgres-live-risk-scope.ts", args: "7405, 0", count: 2 },
    ],
  },
  REFERRAL: {
    purpose: "Referral binding.",
    scope: "xact", form: "pair", namespace: 7410, key: { kind: "const", value: 0 },
    sites: [{ file: "src/referral/referral.repository.ts", args: "7410, 0" }],
  },
  SETTINGS: {
    purpose: "Admin settings section writes.",
    scope: "xact", form: "pair", namespace: 73104, key: { kind: "const", value: 1 },
    sites: [{ file: "src/settings/settings.repository.ts", args: "${advisoryLockKey(\"SETTINGS\")}" }],
  },
  /** Shares namespace 73104 with SETTINGS (key 2 vs 1). scripts/migrate.mjs cannot import this module. */
  MIGRATE: {
    purpose: "Schema migration runner (session lock on its own connection).",
    scope: "session", form: "pair", namespace: 73104, key: { kind: "const", value: 2 },
    sites: [{ file: "scripts/migrate.mjs", args: "73104, 2", count: 2 }],
  },
  RULES: {
    purpose: "Per (chain, address, coin) alert rule evaluation.",
    scope: "xact", form: "pair", namespace: 73105, key: { kind: "hashtext", format: "<chain>|<address>|<coin>" },
    sites: [{ file: "src/rules/rules.repository.ts", args: "73105, hashtext(${`${action.chain}|${action.address}|${action.coin}`})" }],
  },
  /** scripts/worker-smoke.mjs also matches it in pg_locks as classid=73106, objid=1. */
  WORKER: {
    purpose: "Singleton worker lease (session lock on a dedicated connection).",
    scope: "session", form: "pair", namespace: 73106, key: { kind: "const", value: 1 },
    sites: [{ file: "src/runtime/worker-lease.ts", args: "73106, 1", count: 3 }],
  },
  /** The read worker's lease (WORKER_ROLE=read; `all` holds both). */
  WORKER_READ: {
    purpose: "Singleton read-worker lease (session lock on a dedicated connection).",
    scope: "session", form: "pair", namespace: 73106, key: { kind: "const", value: 2 },
    sites: [{ file: "src/runtime/worker-lease.ts", args: "73106, 2", count: 2 }],
  },
  ANALYTICS: {
    purpose: "Per-address trade analytics refresh.",
    scope: "xact", form: "pair", namespace: 73107, key: { kind: "hashtext", format: "<address>" },
    sites: [{ file: "src/traders/trade-analytics.repository.ts", args: "73107, hashtext(${address})" }],
  },

  // ---- single bigint (objsubid = 1) ---------------------------------------
  NOTIFY: {
    purpose: "Copy live notification dispatch.",
    scope: "xact", form: "hashtextextended", seed: 0, key: { kind: "const", text: "copy-live-notify" },
    sites: [{ file: "src/notify/notify.repository.ts", args: "hashtextextended('copy-live-notify', 0)" }],
  },
  COPY_EVENTS: {
    purpose: "Per-user paper copy event stream.",
    scope: "xact", form: "hashtextextended", seed: 0, key: { kind: "prefixed", prefix: "copy-events:", format: "<userId>" },
    sites: [{ file: "src/copy/copy-runtime.repository.ts", args: "hashtextextended(${`copy-events:${userId}`}, 0)" }],
  },
  COPY_OPERATION: {
    purpose: "Per-user paper/virtual copy operation idempotency.",
    scope: "xact", form: "hashtextextended", seed: 0, key: { kind: "prefixed", prefix: "copy-operation:", format: "<userId>:paper:virtual:<key>" },
    sites: [{ file: "src/copy/copy-runtime.repository.ts", args: "hashtextextended(${`copy-operation:${userId}:paper:virtual:${key}`}, 0)" }],
  },
  /** withOrderLock: session try-lock on a dedicated connection; pg_locks heartbeat recomputes the key. */
  LIVE_ORDER: {
    purpose: "Live order dispatch fence.",
    scope: "session", form: "hashtextextended", seed: 1, key: { kind: "prefixed", prefix: "live-order:", format: "<key>" },
    sites: [{ file: "src/copy/live/postgres-live-journal.ts", args: "hashtextextended($1, 1)", count: 2 }],
  },
  LIVE_NONCE: {
    purpose: "Per-signer live nonce allocation.",
    scope: "xact", form: "hashtextextended", seed: 2, key: { kind: "prefixed", prefix: "live-nonce:", format: "<network>:<signerAddress>" },
    sites: [{ file: "src/copy/signer-nonce.ts", args: "hashtextextended(${`live-nonce:${network}:${signerAddress}`}, 2)" }],
  },
  LIVE_PREPARE: {
    purpose: "Live order prepare.",
    scope: "xact", form: "hashtextextended", seed: 3, key: { kind: "prefixed", prefix: "live-prepare:", format: "<key>" },
    sites: [{ file: "src/copy/live/postgres-live-journal.ts", args: "hashtextextended(${`live-prepare:${key}`}, 3)" }],
  },
  RISK_SCOPE_ACCOUNT: {
    purpose: "Live risk scope: trading account collateral (session lock).",
    scope: "session", form: "hashtextextended", seed: 7, key: { kind: "prefixed", prefix: "live-risk-account:", format: "<network>:<accountAddress>" },
    sites: [{ file: "src/copy/live/postgres-live-risk-scope.ts", args: "hashtextextended($1, 7)", count: 2 }],
  },
  /** Session-shared in the risk scope, transaction-exclusive in copy-live-source.repository.ts. */
  RISK_SCOPE_SOURCE: {
    purpose: "Live risk scope: leader source.",
    scope: "session", form: "hashtextextended", seed: 8, key: { kind: "prefixed", prefix: "live-risk-source:", format: "<network>:<leaderAddress>" },
    sites: [
      { file: "src/copy/live/postgres-live-risk-scope.ts", args: "hashtextextended($1, 8)", count: 2 },
      { file: "src/copy/copy-live-source.repository.ts", args: "hashtextextended(${`live-risk-source:${network}:${leaderAddress}`}, 8)" },
    ],
  },
  FOLLOWER_SCAN_BUDGET: {
    purpose: "Per-network follower scan budget (try, skip when busy).",
    scope: "xact", form: "hashtext", key: { kind: "prefixed", prefix: "copy-follower-scan-budget:", format: "<network>" },
    sites: [{ file: "src/copy/copy-follower-scan.repository.ts", args: "hashtext(${`copy-follower-scan-budget:${network}`})" }],
  },
  WATCH_CAPACITY: {
    purpose: "Leader watch capacity admission.",
    scope: "xact", form: "bigint", key: { kind: "const", value: 4_203_401 },
    sites: [{ file: "src/watcher/leader-watch.ts", args: "${WATCH_CAPACITY_LOCK}" }],
  },
} as const satisfies Record<string, AdvisoryLockSpec>;

export type AdvisoryLockName = keyof typeof ADVISORY_LOCKS;

type KeyInput<N extends AdvisoryLockName> = (typeof ADVISORY_LOCKS)[N]["key"] extends { kind: "const" }
  ? []
  : (typeof ADVISORY_LOCKS)[N]["key"] extends { kind: "int" } ? [key: number] : [key: string];

/**
 * The argument list of a `pg_*advisory*` call for this namespace, rendering
 * exactly as the existing call sites do: namespace, seed and constant keys are
 * inlined; caller keys are one bound parameter. `prefixed` keys take only the
 * part after the registered prefix.
 */
export function advisoryLockKey<N extends AdvisoryLockName>(name: N, ...input: KeyInput<N>): SQL {
  const spec: AdvisoryLockSpec = ADVISORY_LOCKS[name];
  const [value] = input as [unknown?];
  switch (spec.form) {
    case "pair": {
      const ns = sql.raw(String(spec.namespace));
      if (spec.key.kind === "const") return sql.raw(`${spec.namespace}, ${spec.key.value}`);
      if (spec.key.kind === "int") {
        const { min, max } = spec.key;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name} advisory lock key`);
        return sql`${ns}, ${value}`;
      }
      return sql`${ns}, hashtext(${text(name, value)})`;
    }
    case "hashtextextended": {
      const seed = sql.raw(String(spec.seed));
      if (spec.key.kind === "const") {
        if (!/^[a-z0-9:-]+$/.test(spec.key.text)) throw new Error(`Invalid ${name} advisory lock text`);
        return sql.raw(`hashtextextended('${spec.key.text}', ${spec.seed})`);
      }
      return sql`hashtextextended(${spec.key.prefix + text(name, value)}, ${seed})`;
    }
    case "hashtext":
      return sql`hashtext(${spec.key.prefix + text(name, value)})`;
    case "bigint":
      return sql`${spec.key.value}`;
  }
}

function text(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name} advisory lock key`);
  return value;
}

/**
 * Structural collisions between registered namespaces (empty when sound).
 * Pair form: the same namespace may be shared only by keys that cannot be
 * equal. Bigint form: the same hash function and seed may be shared only by
 * key strings that cannot be equal (neither prefix starts the other).
 */
export function advisoryLockCollisions(registry: Readonly<Record<string, AdvisoryLockSpec>> = ADVISORY_LOCKS): string[] {
  const entries = Object.entries(registry);
  const found: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [an, a] = entries[i]!, [bn, b] = entries[j]!;
      if (overlaps(a, b)) found.push(`${an} ↔ ${bn}`);
    }
  }
  return found;
}

function overlaps(a: AdvisoryLockSpec, b: AdvisoryLockSpec): boolean {
  if (a.form === "pair" && b.form === "pair") {
    if (a.namespace !== b.namespace) return false;
    return pairKeysOverlap(a.key, b.key);
  }
  if (a.form === "bigint" && b.form === "bigint") return a.key.value === b.key.value;
  const sa = stringSpace(a), sb = stringSpace(b);
  if (!sa || !sb || sa.hash !== sb.hash) return false;
  if (sa.exact && sb.exact) return sa.text === sb.text;
  if (sa.exact) return sa.text.startsWith(sb.text);
  if (sb.exact) return sb.text.startsWith(sa.text);
  return sa.text.startsWith(sb.text) || sb.text.startsWith(sa.text);
}

type PairKey = Extract<AdvisoryLockSpec, { form: "pair" }>["key"];
function pairKeysOverlap(a: PairKey, b: PairKey): boolean {
  if (a.kind === "hashtext" || b.kind === "hashtext") return true;
  if (a.kind === "const" && b.kind === "const") return a.value === b.value;
  if (a.kind === "int" && b.kind === "int") return a.min <= b.max && b.min <= a.max;
  const [range, fixed] = a.kind === "int" ? [a, b as Extract<PairKey, { kind: "const" }>] : [b as Extract<PairKey, { kind: "int" }>, a];
  return fixed.value >= range.min && fixed.value <= range.max;
}

/** For string-hashed keys: the hash function+seed and the fixed text every key starts with. */
function stringSpace(spec: AdvisoryLockSpec): { hash: string; text: string; exact: boolean } | undefined {
  if (spec.form === "hashtextextended") {
    return spec.key.kind === "const"
      ? { hash: `hashtextextended/${spec.seed}`, text: spec.key.text, exact: true }
      : { hash: `hashtextextended/${spec.seed}`, text: spec.key.prefix, exact: false };
  }
  if (spec.form === "hashtext") return { hash: "hashtext", text: spec.key.prefix, exact: false };
  return undefined;
}
