import { currentRequestSignal } from "../runtime/request-context.js";

/**
 * Small in-process TTL cache with in-flight de-duplication: while a load for
 * a key is running, every other caller for that key awaits the same promise,
 * so N concurrent page loads for one trader make one upstream call. Failed
 * loads are not cached. Size is bounded: expired entries are dropped first,
 * then the oldest.
 *
 * Expired entries are released even if nobody reads their key again: `set`
 * sweeps them at most once per sweep interval (amortized). A cache of large
 * values (a trader's 4 000 fills) also passes `sweepTimer`: while it holds
 * anything an unref'd timer sweeps on the same interval, so an idle cache
 * does not stay resident until 5 000 other keys push it out.
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
  /** How often expired entries are swept: the TTL, clamped to 1 s – 60 s. */
  readonly sweepIntervalMs: number;
  private lastSweepAt: number;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ttlMs: number,
    readonly maxEntries = 5_000,
    private readonly now: () => number = () => Date.now(),
    private readonly options: { sweepTimer?: boolean } = {},
  ) {
    this.sweepIntervalMs = Math.min(60_000, Math.max(1_000, ttlMs));
    this.lastSweepAt = now();
  }

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
    const now = this.now();
    if (now - this.lastSweepAt >= this.sweepIntervalMs) this.sweepExpired();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + ttlMs, observedAt: now });
    this.armSweeper();
    if (this.entries.size <= this.maxEntries) return;
    this.sweepExpired();
    // Map iteration is insertion order, and `set` re-inserts, so the first
    // keys are the least recently written.
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
    }
  }

  /** Drops every expired entry. */
  sweepExpired(): void {
    const now = this.now();
    this.lastSweepAt = now;
    for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
  }

  /** Sweeps on a timer while there is anything to sweep; the timer never
   * keeps the process alive and stops once the cache is empty. */
  private armSweeper(): void {
    if (!this.options.sweepTimer || this.sweeper !== undefined) return;
    this.sweeper = setInterval(() => {
      this.sweepExpired();
      if (this.entries.size === 0) this.stopSweeper();
    }, this.sweepIntervalMs);
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (this.sweeper === undefined) return;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
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
    this.stopSweeper();
  }
}

/** An abort or timeout that is not this caller's own request's. */
function isForeignAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  if (name !== "AbortError" && name !== "TimeoutError") return false;
  return currentRequestSignal()?.aborted !== true;
}
