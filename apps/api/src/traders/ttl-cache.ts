import { currentRequestSignal } from "../runtime/request-context.js";

/**
 * In-process TTL cache with in-flight de-duplication (concurrent callers for
 * a key share one load). Failed loads are not cached. Bounded: expired
 * entries go first, then the oldest. `set` sweeps expired entries at most
 * once per interval; `sweepTimer` adds an unref'd timer so large idle values
 * are released.
 *
 * A shared load runs in its starter's async context (budget rank, request
 * cancellation), so a joiner never inherits a worse fate:
 * - a caller with a better (lower) `rank` starts its own load instead;
 * - a joiner whose load was aborted by someone else's request loads again
 *   while its own request is alive.
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

  /** Fresh value, else the load in flight, else a new load. `rank`: lower
   * goes first; omitted, the caller joins whatever is running. */
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
