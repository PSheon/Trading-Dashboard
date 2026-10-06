import { z } from 'zod';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { LiveBoundaryError, type LiveNetwork } from './wallet-authorization.js';
import type { LiveSharedReads } from './live-shared-reads.js';

export interface LiveMarketIdentity {
  network: LiveNetwork;
  coin: string;
  dex: string;
  asset: number;
  universeIndex: number;
  perpDexIndex: number;
  sizeDecimals: number;
  maxLeverage: number;
  observedAt: number;
}
export interface LiveMarketResolver {
  readonly network: LiveNetwork;
  resolve(coin: string): Promise<LiveMarketIdentity>;
  resolveAsset(asset: number): Promise<LiveMarketIdentity>;
}
/** Runs `start()` with a deadline. The timeout is computed first (a lazy
 * `remaining()` may throw once the evidence window has passed), and only
 * then is the work started, with its rejection handled at once. Passing an
 * already started promise was the crash class: `boundedLiveRead(acquire(),
 * remaining())` started the read, `remaining()` threw before the helper was
 * entered, and the orphaned read's later rejection was unhandled. */
export async function boundedLiveRead<T>(start: () => PromiseLike<T> | T, timeout: number | (() => number)): Promise<T> {
  if (typeof start !== 'function') throw new LiveBoundaryError('live_read_invalid');
  const timeoutMs = typeof timeout === 'function' ? timeout() : timeout;
  if (!Number.isFinite(timeoutMs)) throw new LiveBoundaryError('live_read_invalid');
  let work: Promise<T>;
  try { work = Promise.resolve(start()); } catch (error) { work = Promise.reject(error); }
  // When the deadline wins, `work` may still reject later (its own abort
  // signal, a refused budget): handle that rejection here, or Node treats it
  // as unhandled and takes the whole process down.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LiveBoundaryError('live_read_deadline_exceeded')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
const marketSchema = z.object({ name: z.string().min(1).max(80), szDecimals: z.number().int().min(0).max(6),
  maxLeverage: z.number().int().positive(), isDelisted: z.boolean().optional() });
const metaSchema = z.object({ universe: z.array(marketSchema).max(10_000) });
export const MAX_LIVE_PERP_DEXES = 1000;
/** Longest an up-front weight reservation (before any evidence clock) may
 * take when the budget itself sets no bound. */
export const RESERVE_BOUND_MS = 10_000;
// Provider-listed names are opaque identifiers (testnet includes i<3fl).
// Separators, spot formats, whitespace and control characters stay unsupported.
export const LIVE_DEX_NAME = /^[^:\s/@\p{Cc}\p{Cf}]{1,40}$/u;
export const LIVE_PERP_COIN = /^(?:[^:\s/@\p{Cc}\p{Cf}]{1,40}:)?[^:\s/@\p{Cc}\p{Cf}]{1,80}$/u;
const dexSchema = z.array(z.object({ name: z.string().regex(LIVE_DEX_NAME).max(40) }).nullable()).min(1).max(MAX_LIVE_PERP_DEXES);
function uniqueMarketNames(names: readonly string[]): void {
  if (new Set(names).size !== names.length) throw new LiveBoundaryError('live_market_duplicate_identity');
}

/** Coordinates are identity; observedAt/maxLeverage are observation data. */
export function marketIdentityKey(m: LiveMarketIdentity) {
  assertMarketIdentity(m);
  return { network: m.network, coin: m.coin, dex: m.dex, asset: m.asset,
    universeIndex: m.universeIndex, perpDexIndex: m.perpDexIndex, sizeDecimals: m.sizeDecimals };
}
export function assertMarketIdentity(m: LiveMarketIdentity): void {
  if (!m || !['testnet', 'mainnet'].includes(m.network) || typeof m.coin !== 'string' ||
      !LIVE_PERP_COIN.test(m.coin) || m.coin.length > 80 || !Number.isSafeInteger(m.universeIndex) || m.universeIndex < 0 || m.universeIndex >= 10_000 ||
      !Number.isSafeInteger(m.perpDexIndex) || m.perpDexIndex < 0 || m.perpDexIndex >= MAX_LIVE_PERP_DEXES ||
      !Number.isSafeInteger(m.asset) || m.asset < 0 ||
      !Number.isSafeInteger(m.sizeDecimals) || m.sizeDecimals < 0 || m.sizeDecimals > 6 ||
      !Number.isSafeInteger(m.observedAt) || m.observedAt < 0 || !Number.isFinite(m.maxLeverage) || m.maxLeverage <= 0 ||
      (m.dex === '' ? m.perpDexIndex !== 0 || m.coin.includes(':') || m.asset !== m.universeIndex
        : !LIVE_DEX_NAME.test(m.dex) || m.perpDexIndex === 0 || !m.coin.startsWith(`${m.dex}:`) ||
          m.coin.length === m.dex.length + 1 || m.asset !== 100_000 + m.perpDexIndex * 10_000 + m.universeIndex)) {
    throw new LiveBoundaryError('invalid_live_market_identity');
  }
}

/** Uncached network-specific observations. Original dex indices (including nulls)
 * are retained. No old metadata is returned after an unavailable read. */
export class HyperliquidLiveMarketResolver implements LiveMarketResolver {
  private readonly endpoint: string;
  constructor(readonly network: LiveNetwork, private readonly acquire: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now, private readonly maxAgeMs = 5_000) {
    if (!['testnet', 'mainnet'].includes(network) || typeof acquire !== 'function' ||
        !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 5_000) throw new LiveBoundaryError('invalid_market_resolver');
    this.endpoint = network === 'testnet' ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info';
  }
  /** With an order epoch's `shared` reads (testnet), its paid, memoised
   * reads and its clock: one `meta` read serves every coin of the dex. */
  async resolve(coin: string, shared?: LiveSharedReads): Promise<LiveMarketIdentity> {
    if (typeof coin !== 'string' || !LIVE_PERP_COIN.test(coin) || coin.length > 80)
      throw new LiveBoundaryError('invalid_live_market_coin');
    if (shared && this.network !== 'testnet') throw new LiveBoundaryError('invalid_market_resolver');
    const dex = coin.includes(':') ? coin.split(':')[0]! : '';
    // perpDexs (a named dex) and meta, 20 each, paid before the clock starts.
    if (!shared) await boundedLiveRead(() => this.acquire(dex ? 40 : 20), RESERVE_BOUND_MS);
    const started = shared ? shared.startedAt : this.now();
    const read = (body: Record<string, string>) => shared ? this.sharedRead(shared, body, started) : this.read(body, started);
    let index = 0;
    if (dex) {
      const dexes = dexSchema.parse(await read({ type: 'perpDexs' }));
      if (dexes[0] !== null) throw new LiveBoundaryError('invalid_perp_dex_indices');
      uniqueMarketNames(dexes.flatMap((row) => row ? [row.name] : []));
      const matches = dexes.flatMap((row, i) => row?.name === dex ? [i] : []);
      if (matches.length !== 1 || matches[0] === 0) throw new LiveBoundaryError('live_market_not_listed');
      index = matches[0]!;
    }
    const meta = metaSchema.parse(await read({ type: 'meta', ...(dex ? { dex } : {}) }));
    uniqueMarketNames(meta.universe.map((row) => row.name));
    const matches = meta.universe.flatMap((row, i) => row.name === coin ? [i] : []);
    if (matches.length !== 1) throw new LiveBoundaryError('live_market_not_listed');
    return this.identity(meta.universe[matches[0]!]!, matches[0]!, dex, index, started);
  }
  async resolveAsset(asset: number, shared?: LiveSharedReads): Promise<LiveMarketIdentity> {
    if (!Number.isSafeInteger(asset) || asset < 0 || (asset >= 10_000 && asset < 110_000))
      throw new LiveBoundaryError('unsupported_perpetual_asset');
    if (shared && this.network !== 'testnet') throw new LiveBoundaryError('invalid_market_resolver');
    const dexIndex = asset < 10_000 ? 0 : Math.floor((asset - 100_000) / 10_000);
    if (dexIndex >= MAX_LIVE_PERP_DEXES) throw new LiveBoundaryError('live_market_not_listed');
    if (!shared) await boundedLiveRead(() => this.acquire(dexIndex ? 40 : 20), RESERVE_BOUND_MS);
    const started = shared ? shared.startedAt : this.now();
    const read = (body: Record<string, string>) => shared ? this.sharedRead(shared, body, started) : this.read(body, started);
    let dex = '';
    if (dexIndex) {
      const dexes = dexSchema.parse(await read({ type: 'perpDexs' }));
      if (dexes[0] !== null) throw new LiveBoundaryError('invalid_perp_dex_indices');
      uniqueMarketNames(dexes.flatMap((row) => row ? [row.name] : []));
      dex = dexes[dexIndex]?.name ?? '';
      if (!dex) throw new LiveBoundaryError('live_market_not_listed');
    }
    const i = dexIndex ? (asset - 100_000) % 10_000 : asset;
    const meta = metaSchema.parse(await read({ type: 'meta', ...(dex ? { dex } : {}) }));
    uniqueMarketNames(meta.universe.map((row) => row.name));
    const market = meta.universe[i];
    if (!market) throw new LiveBoundaryError('live_market_not_listed');
    return this.identity(market, i, dex, dexIndex, started);
  }
  private identity(m: z.infer<typeof marketSchema>, i: number, dex: string, dexIndex: number, started: number): LiveMarketIdentity {
    if (m.isDelisted) throw new LiveBoundaryError('live_market_delisted');
    this.fresh(started);
    const result = { network: this.network, coin: m.name, dex, universeIndex: i, perpDexIndex: dexIndex,
      asset: dexIndex ? 100_000 + dexIndex * 10_000 + i : i, sizeDecimals: m.szDecimals,
      maxLeverage: m.maxLeverage, observedAt: started };
    assertMarketIdentity(result);
    return result;
  }
  private fresh(started: number) {
    if (this.now() < started || this.now() - started > this.maxAgeMs) throw new LiveBoundaryError('market_evidence_expired');
  }
  private async sharedRead(shared: LiveSharedReads, body: Record<string, string>, started: number): Promise<unknown> {
    this.fresh(started);
    const value = await boundedLiveRead(() => shared.get(body), Math.max(1, this.maxAgeMs - (this.now() - started)));
    this.fresh(started);
    return value;
  }
  private async read(body: Record<string, string>, started: number): Promise<unknown> {
    this.fresh(started);
    const remaining = Math.max(1, this.maxAgeMs - (this.now() - started));
    const response = await boundedLiveRead(() => this.fetcher(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(remaining) }), remaining);
    if (!response.ok) throw new LiveBoundaryError('market_evidence_unavailable');
    const result = await boundedLiveRead(() => readInfoJson(response, 'live market', 2 * 1024 * 1024),
      Math.max(1, this.maxAgeMs - (this.now() - started)));
    this.fresh(started);
    return result;
  }
}
