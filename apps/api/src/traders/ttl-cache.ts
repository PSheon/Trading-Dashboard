import { currentRequestSignal } from "../runtime/request-context.js";

/**
 * Small in-process TTL cache with in-flight de-duplication: while a load for
 * a key is running, every other caller for that key awaits the same promise,
 * so N concurrent page loads for one trader make one upstream call. Failed
 * loads are not cached. Size is bounded: expired entries are dropped first,
 * then the oldest.
 *
 * A shared load runs in the async context of whoever started it: its
 * Hyperliquid calls wait at that caller's budget rank and are cancelled with
 * that caller's request. Two rules keep a joiner from inheriting a worse
 * fate than its own:
 *
 * - a caller with a better (lower) `rank` than the load in flight starts
 *   its own load instead of joining (a trader page's chart, rank 1, must
 *   not wait behind a sparkline batch's read of the same address at rank
 *   2, nor behind a pool job's unranked one); later callers join the
 *   better load;
 * - a joiner whose shared load was aborted by someone else's request
 *   (answered, abandoned or timed out) loads again for itself, as long as
 *   its own request is still alive.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number; observedAt: number }>();
  private readonly inflight = new Map<string, { promise: Promise<V>; rank: number | undefined }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The fresh value, else the load in flight (see the class comment), else
   * a new load. `rank` is the caller's budget rank (lower goes first);
   * omitted, the caller joins whatever is running.
   */
  get(key: string, load: () => Promise<V>, ttlMs: number | ((value: V) => number) = this.ttlMs, rank?: number): Promise<V> {
    const hit = this.peek(key);
    if (hit !== undefined) return Promise.resolve(hit.value);
    const running = this.inflight.get(key);
    if (!running) return this.start(key, load, ttlMs, rank);
    if (rank !== undefined && (running.rank === undefined || rank < running.rank)) return this.start(key, load, ttlMs, rank);
    return this.join(key, running.promise, load, ttlMs, rank);
  }

  /** Reloads `key` even if fresh (joining a load already in flight) and
   * keeps the result for `ttlMs` (default: the cache's TTL). Used to warm
   * entries before they expire. */
  refresh(key: string, load: () => Promise<V>, ttlMs = this.ttlMs): Promise<V> {
    const running = this.inflight.get(key);
    return running ? this.join(key, running.promise, load, ttlMs, undefined) : this.start(key, load, ttlMs);
  }

  /** Waits for `promise`; if it was cut short by another request's abort
   * while this caller's request is still live, loads again for this caller
   * (joining a newer load if one has started since). */
  private join(key: string, promise: Promise<V>, load: () => Promise<V>, ttlMs: number | ((value: V) => number), rank: number | undefined): Promise<V> {
    return promise.catch((error: unknown) => {
      if (!isForeignAbort(error)) throw error;
      const hit = this.peek(key);
      if (hit !== undefined) return hit.value;
      const running = this.inflight.get(key);
      return running ? this.join(key, running.promise, load, ttlMs, rank) : this.start(key, load, ttlMs, rank);
    });
  }

  private start(key: string, load: () => Promise<V>, ttlMs: number | ((value: V) => number) = this.ttlMs, rank?: number): Promise<V> {
    const entry = { rank } as { promise: Promise<V>; rank: number | undefined };
    entry.promise = (async () => {
      try {
        const value = await load();
        this.set(key, value, typeof ttlMs === "function" ? ttlMs(value) : ttlMs);
        return value;
      } finally {
        // A better-ranked load may have replaced this one meanwhile.
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, entry);
    return entry.promise;
  }

  /** The cached value if still fresh. Wrapped so a cached `undefined` is
   * distinguishable from a miss. */
  peek(key: string): { value: V } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: entry.value };
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs, observedAt: this.now() });
    if (this.entries.size <= this.maxEntries) return;
    const now = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
    // Map iteration is insertion order, and `set` re-inserts, so the first
    // keys are the least recently written.
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
    }
  }

  /** Observation time survives cache hits; never pretend a hit is a new fetch. */
  observedAt(key: string): number | null {
    return this.peek(key) === undefined ? null : this.entries.get(key)!.observedAt;
  }

  /** The rank of the load in flight for `key`, if any (tests). */
  inflightRank(key: string): number | undefined | null {
    const running = this.inflight.get(key);
    return running ? running.rank : null;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drops every stored entry (tests); loads in flight still complete. */
  clear(): void {
    this.entries.clear();
  }
}

/** An abort or timeout that is not this caller's own request's. */
function isForeignAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  if (name !== "AbortError" && name !== "TimeoutError") return false;
  return currentRequestSignal()?.aborted !== true;
}
