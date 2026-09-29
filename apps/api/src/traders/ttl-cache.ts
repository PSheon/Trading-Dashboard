/**
 * Small in-process TTL cache with in-flight de-duplication: while a load for
 * a key is running, every other caller for that key awaits the same promise,
 * so N concurrent page loads for one trader make one upstream call. Failed
 * loads are not cached. Size is bounded: expired entries are dropped first,
 * then the oldest.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.peek(key);
    if (hit !== undefined) return Promise.resolve(hit.value);
    return this.inflight.get(key) ?? this.start(key, load);
  }

  /** Reloads `key` even if fresh (joining a load already in flight) and
   * keeps the result for `ttlMs` (default: the cache's TTL). Used to warm
   * entries before they expire. */
  refresh(key: string, load: () => Promise<V>, ttlMs = this.ttlMs): Promise<V> {
    return this.inflight.get(key) ?? this.start(key, load, ttlMs);
  }

  private start(key: string, load: () => Promise<V>, ttlMs = this.ttlMs): Promise<V> {
    const promise = (async () => {
      try {
        const value = await load();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
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
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
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

  get size(): number {
    return this.entries.size;
  }
}
