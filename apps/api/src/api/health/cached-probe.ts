import { HEALTH_CACHE_MS } from '../../config/constants/http.js';

/**
 * Single-flight probe whose result (success or failure) answers everyone for
 * `ttlMs`, so the work behind `/health` runs at most about once per `ttlMs`.
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
