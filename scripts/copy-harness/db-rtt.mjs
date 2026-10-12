// Copy harness — a database round trip for the local stack (TEST ONLY).
//
// Stage's api and worker reach their Postgres in ~8 ms; the local one answers
// in ~0 ms, so the local harness never saw an order whose meter transactions
// cost seconds of evidence (live_risk_stale, Stage 2026-10-12). With
// COPY_HARNESS_DB_RTT_MS=<ms> (harness profile stage-like.env), stack.mjs
// starts the api and the worker with `--import db-rtt.preload.mjs`, and every
// statement a pg client sends waits that long first (as
// apps/api/test/hyperliquid-live-meter-contention.spec.ts does to one pool).
// Nothing in apps/api reads the variable; production never loads this file,
// and it refuses NODE_ENV=production.

/** The configured round trip in ms: 0 (off) when unset; an integer 0–1000, else an error. */
export function rttFromEnv(env = process.env) {
  const raw = env.COPY_HARNESS_DB_RTT_MS;
  if (raw === undefined || raw.trim() === "") return 0;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0 || ms > 1000) throw new Error(`COPY_HARNESS_DB_RTT_MS must be an integer 0–1000 (ms), got ${JSON.stringify(raw)}`);
  if (ms > 0 && env.NODE_ENV === "production") throw new Error("COPY_HARNESS_DB_RTT_MS is a local harness knob: refused with NODE_ENV=production");
  return ms;
}

const INSTALLED = Symbol.for("copy-harness.db-rtt");

/**
 * Delays every `query` of `Client` (pg's client class, so pooled clients and
 * transactions too) by `ms` before it is sent. Callback and promise calls are
 * both delayed; a submittable (a cursor or stream: `submit()`) goes through
 * untouched. One fixed delay keeps statements in the order they were issued.
 * Idempotent; returns a restore function. `ms` 0 changes nothing.
 * @param {{ prototype: { query: (...args: unknown[]) => unknown } }} Client
 * @param {number} ms
 * @param {{ onQuery?: () => void }} [options]
 */
export function installDbRtt(Client, ms, { onQuery } = {}) {
  const proto = Client.prototype;
  if (!(ms > 0)) return () => {};
  if (proto[INSTALLED]) throw new Error(`a database round trip is already installed (${proto[INSTALLED]} ms)`);
  const original = proto.query;
  proto.query = function delayedQuery(...args) {
    const config = args[0];
    if (config && typeof config === "object" && typeof config.submit === "function") return original.apply(this, args);
    onQuery?.();
    if (args.some((a) => typeof a === "function") || (config && typeof config === "object" && typeof config.callback === "function")) {
      setTimeout(() => original.apply(this, args), ms);
      return undefined;
    }
    return new Promise((resolve) => setTimeout(resolve, ms)).then(() => original.apply(this, args));
  };
  proto[INSTALLED] = ms;
  return () => { proto.query = original; delete proto[INSTALLED]; };
}
