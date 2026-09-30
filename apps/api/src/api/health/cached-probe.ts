/** How long a health or readiness answer is reused. */
export const HEALTH_CACHE_MS = 1_000;

/**
 * Single-flight, briefly cached probe: callers arriving while a probe runs
 * share it, and its result (success or failure) answers everyone for
 * `ttlMs` after it settles. However hard `/health` or `/health/ready` is
 * hit, the work behind it (a database round trip, the worker heartbeat)
 * runs at most about once per `ttlMs`.
 */
export class CachedProbe<T> {
  private pending: Promise<T> | undefined;
  private settled: { at: number; result: Promise<T> } | undefined;

  constructor(private readonly ttlMs = HEALTH_CACHE_MS, private readonly now: () => number = () => Date.now()) {}

  get(load: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending;
    if (this.settled && this.now() - this.settled.at < this.ttlMs) return this.settled.result;
    const result = Promise.resolve().then(load);
    this.pending = result;
    const settle = () => {
      this.pending = undefined;
      this.settled = { at: this.now(), result };
    };
    result.then(settle, settle);
    return result;
  }
}
