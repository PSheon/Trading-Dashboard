import { isDeepStrictEqual } from 'node:util';
import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';

/**
 * Evidence reads that do not change between orders, kept across them (the
 * order evidence of 2026-10-12 read 589 weight an order, 200 of each
 * account's 204 for facts that never or rarely change: one order every two
 * minutes in a 300/min bucket, and two owners queued past their signals).
 *
 * Only these are kept, and only while they hold the value an order may go
 * on, so a refusal is never remembered and an unusual value is read anew
 * every time:
 * - an account's role `user` (30 min; a role never changes once set);
 * - its abstraction `disabled` and dex abstraction `false` (5 min: only the
 *   account's signers can change them, our own setup being the only one
 *   that does; an order under a mode changed by someone else in that window
 *   still meets the exchange's own margin checks);
 * - the dex list, spot and perp metadata and a dex's meta (60 s: a market
 *   listed since is unknown for a minute and its order refused);
 * - an account's fee schedule (5 min).
 * Positions, balances, prices, leverage and the spot state are never kept:
 * every order reads them within its 5 s clock.
 */
const TTL_MS: Readonly<Record<string, number>> = {
  userRole: 30 * 60_000, userAbstraction: 5 * 60_000, userDexAbstraction: 5 * 60_000,
  perpDexs: 60_000, spotMeta: 60_000, allPerpMetas: 60_000, meta: 60_000, userFees: 5 * 60_000,
};
/** Whether `value` is the one an order may go on (the only one kept). */
function keepable(type: string, value: unknown): boolean {
  if (type === 'userRole') return isDeepStrictEqual(value, { role: 'user' });
  if (type === 'userAbstraction') return value === 'disabled';
  if (type === 'userDexAbstraction') return value === false;
  return value !== null && value !== undefined;
}
const keyOf = (body: Readonly<Record<string, unknown>>) => JSON.stringify(Object.keys(body).sort().map(key => [key, body[key]]));
/** At most this many entries (accounts × 4 + markets); the oldest go first. */
const MAX_ENTRIES = 5_000;

export class LiveReadCache {
  readonly #entries = new Map<string, { value: unknown; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  /** Whether `body` is a read this cache may keep. */
  static cacheable(body: Readonly<Record<string, unknown>>): boolean { return String(body.type) in TTL_MS; }
  /** A kept value (a copy), or undefined when none is fresh. */
  get(body: Readonly<Record<string, unknown>>): unknown {
    const key = keyOf(body), entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= this.now()) { this.#entries.delete(key); return undefined; }
    return structuredClone(entry.value);
  }
  /** Keeps a value just read, when its type and value may be kept. */
  put(body: Readonly<Record<string, unknown>>, value: unknown): void {
    const type = String(body.type);
    if (!LiveReadCache.cacheable(body) || !keepable(type, value)) return;
    const key = keyOf(body);
    this.#entries.delete(key);
    if (this.#entries.size >= MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
    this.#entries.set(key, { value: structuredClone(value), until: this.now() + TTL_MS[type]! });
  }
  /** Forgets everything kept about `user` (its modes and fees). */
  forget(user: string): void {
    const lower = user.toLowerCase();
    for (const key of this.#entries.keys()) if (key.toLowerCase().includes(`"user","${lower}"`)) this.#entries.delete(key);
  }
}

const caches = new Map<HyperliquidNetwork, LiveReadCache>();
/** The process's cache for `network` (every evidence epoch on it shares it). */
export function liveReadCache(network: HyperliquidNetwork): LiveReadCache {
  let cache = caches.get(network);
  if (!cache) { cache = new LiveReadCache(); caches.set(network, cache); }
  return cache;
}
/** Tests only: start every network's cache empty. */
export function resetLiveReadCaches(): void { caches.clear(); }
