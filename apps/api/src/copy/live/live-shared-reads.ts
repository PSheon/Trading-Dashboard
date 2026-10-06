import { isDeepStrictEqual } from 'node:util';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { boundedLiveRead } from './live-market-resolver.js';
import { LiveBoundaryError } from './wallet-authorization.js';
import { HYPERLIQUID_BACKGROUND_REST_CAP, HYPERLIQUID_REST_CAP } from '../../hyperliquid/hyperliquid-global-quota.js';
import type { LiveReserveOptions } from '../../hyperliquid/hyperliquid-budget-wait.js';

const ENDPOINT = 'https://api.hyperliquid-testnet.xyz/info';
/** Hyperliquid's info weights for the reads evidence uses (the shared meter's
 * table, hyperliquid-global-transport.ts): 2 for the cheap reads, 60 for
 * userRole, 20 for every other one. */
export function liveInfoWeight(body: Readonly<Record<string, unknown>>): number {
  return body.type === 'userRole' ? 60 : ['spotClearinghouseState', 'clearinghouseState', 'allMids', 'orderStatus'].includes(String(body.type)) ? 2 : 20;
}
export const liveInfoWeights = (bodies: readonly Readonly<Record<string, unknown>>[]) => bodies.reduce((sum, body) => sum + liveInfoWeight(body), 0);
/** Several reads sent together under ONE shared-meter charge
 * (`HyperliquidGlobalTransport.fetchInfoBatch`); `onDispatch` runs as they go out. */
export type LiveInfoBatch = (bodies: readonly Readonly<Record<string, unknown>>[], onDispatch: () => void) => Promise<Response[]>;
/** A body's identity, whatever its key order. */
const keyOf = (body: Readonly<Record<string, unknown>>) => JSON.stringify(Object.keys(body).sort().map(key => [key, body[key]]));
/** The account-mode reads a dedicated standard account is proven by. */
export const accountModeBodies = (user: string) => [{ type: 'userRole', user }, { type: 'userAbstraction', user },
  { type: 'userDexAbstraction', user }, { type: 'spotClearinghouseState', user }];

/** An order evidence epoch's first wave: every observed user's account modes,
 * the dex list, spot and perp metadata, the order dex's metadata and
 * contexts, the target's leverage for the coin and its fees. */
export function evidenceFirstWave(users: readonly string[], target: string, coin: string): Record<string, unknown>[] {
  const dex = coin.includes(':') ? coin.split(':')[0]! : '';
  return [...users.flatMap(accountModeBodies), { type: 'perpDexs' }, { type: 'spotMeta' }, { type: 'allPerpMetas' },
    { type: 'meta', ...(dex ? { dex } : {}) }, { type: 'metaAndAssetCtxs', dex }, { type: 'activeAssetData', user: target, coin }, { type: 'userFees', user: target }];
}
/** Its final check: the account modes and the dex list once more. */
export const evidenceFinalCheck = (users: readonly string[]): Record<string, unknown>[] => [...users.flatMap(accountModeBodies), { type: 'perpDexs' }];
/** What an order's evidence pays before its clock starts, for `users`
 * observed accounts (the owner's live accounts, plus the leader for a
 * testnet ratio open): 204 a user + 160 (568 for two accounts, 772 with the
 * leader). The other open coins' reads (≤ 60 each) are paid as they go. */
export function liveEvidencePrepaidWeight(users: number): number {
  const addresses = Array.from({ length: users }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`);
  return liveInfoWeights(evidenceFirstWave(addresses, addresses[0] ?? '0x', 'BTC')) + liveInfoWeights(evidenceFinalCheck(addresses));
}
/** The live accounts one owner's evidence may observe (the risk authority's
 * bound, postgres-live-risk-authority.ts). */
export const MAX_LIVE_ACCOUNTS_PER_OWNER = 8;
/** The shared per-IP meter keeps this much for unlabelled work (pages, copy
 * orders) however full the background lane is: no single evidence charge
 * is larger, so a full background lane never refuses one on its own. */
export const MAX_EVIDENCE_CHARGE = HYPERLIQUID_REST_CAP - HYPERLIQUID_BACKGROUND_REST_CAP;
/** Bodies one batch charge may carry (HyperliquidGlobalTransport.fetchInfoBatch). */
const MAX_BATCH_BODIES = 16;

/**
 * Startup check of the order path's token bucket: the heaviest order
 * evidence an owner can need, `maxStrategiesPerUser` live accounts (at most
 * MAX_LIVE_ACCOUNTS_PER_OWNER) plus the leader, must fit the bucket's live
 * capacity, or every one of that owner's orders would wait for a weight the
 * bucket can never hold (Stage 2026-10-06: COPY_LIVE_WEIGHT_PER_MIN=700 left
 * 500, and every order of an owner with three accounts timed out).
 * Throws a clear error to refuse startup; returns the numbers otherwise.
 */
export function assertLiveEvidenceCapacity({ capacity, maxStrategiesPerUser, network, budgetPerMin }:
  { capacity: number; maxStrategiesPerUser: number; network: string; budgetPerMin: number }): { users: number; weight: number; capacity: number } {
  const accounts = Math.max(1, Math.min(maxStrategiesPerUser, MAX_LIVE_ACCOUNTS_PER_OWNER)), users = accounts + 1, weight = liveEvidencePrepaidWeight(users);
  if (weight > capacity) throw new Error(`Live copy orders can't run: one order's evidence for an owner with ${accounts} live account${accounts === 1 ? '' : 's'} plus the leader weighs ${weight}, ` +
    `more than the ${network} order bucket can hold (${capacity} at ${budgetPerMin}/min: capacity = min(burst, 1200 − rate)). ` +
    (network === 'testnet' ? 'Lower COPY_LIVE_WEIGHT_PER_MIN (default 300: capacity 900)' : 'Set HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN / HYPERLIQUID_WORKER_WEIGHT_BURST on the worker (360 / 840: capacity 840)') +
    `, or lower maxStrategiesPerUser in the admin copy risk policy (${Math.max(0, Math.floor((capacity - liveEvidencePrepaidWeight(1)) / (liveEvidencePrepaidWeight(2) - liveEvidencePrepaidWeight(1))))} fit).`);
  return { users, weight, capacity };
}

/**
 * The provider reads of ONE order's evidence epoch, shared by the account
 * observer, the market resolver and the risk provider: the account modes,
 * the dex list, spot and perp metadata, the dex's contexts and the fees are
 * read once per epoch instead of once per reader and coin. Each wave of
 * reads goes out together (one meter charge when a batch transport is
 * given). The epoch's caller pays the weight before `begin`, so no budget
 * wait runs inside the 5 s evidence clock, which starts at `begin`.
 * Values are memoised by request body; a read that fails fails every
 * reader that uses it. The final account-mode check is read anew.
 */
export class LiveSharedReads {
  readonly #memo = new Map<string, Promise<unknown>>();
  #startedAt: number | undefined;
  #begin!: () => void;
  /** Settles once the first wave went out (the clock started). */
  readonly begun = new Promise<void>(resolve => { this.#begin = resolve; });
  /** REST weight of every read sent so far, and of the reads paid for. */
  sentWeight = 0;
  paidWeight = 0;
  #credit = 0;
  constructor(private readonly fetcher: typeof fetch, private readonly batch: LiveInfoBatch | undefined, private readonly now: () => number,
    private readonly maxAgeMs = 5000, private readonly acquire?: (weight: number, options?: LiveReserveOptions) => Promise<unknown>) {}
  /** Pays for reads ahead (before the clock starts): no budget wait later.
   * The budget bounds the wait itself (reserveLive: the bucket's refill
   * time; a reservation it can never hold fails at once). */
  async pay(weight: number, options?: LiveReserveOptions): Promise<void> {
    if (!this.acquire || weight <= 0) return;
    await this.acquire(weight, options);
    this.paidWeight += weight; this.#credit += weight;
  }
  /** Each send is paid from what was paid ahead, or acquired now: inside the
   * clock, waiting no longer than the evidence has left. */
  private async spend(weight: number): Promise<void> {
    this.sentWeight += weight;
    const short = weight - this.#credit;
    this.#credit = Math.max(0, this.#credit - weight);
    if (short > 0) await this.pay(short, this.#startedAt === undefined ? undefined : { maxWaitMs: this.fresh() }).then(() => { this.#credit -= short; });
  }
  /** Sends `bodies` in charges of at most MAX_EVIDENCE_CHARGE weight and 16
   * bodies (one meter charge each when a batch transport is given), all at
   * once; `onDispatch` runs as the first goes out. */
  private send(bodies: readonly Readonly<Record<string, unknown>>[], onDispatch: () => void): Promise<Response[]> {
    const chunks: Readonly<Record<string, unknown>>[][] = [];
    let weight = 0;
    for (const body of bodies) {
      const last = chunks.at(-1), w = liveInfoWeight(body);
      if (!last || last.length >= MAX_BATCH_BODIES || weight + w > MAX_EVIDENCE_CHARGE) { chunks.push([body]); weight = w; }
      else { last.push(body); weight += w; }
    }
    return Promise.all(chunks.map(chunk => {
      if (this.batch && chunk.length > 1) return this.batch(chunk, onDispatch);
      onDispatch();
      return Promise.all(chunk.map(body => boundedLiveRead(() => this.fetcher(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(this.fresh()) }), this.fresh())));
    })).then(lists => lists.flat());
  }
  /** The epoch clock: every reader's evidence is no older than this. */
  get startedAt(): number {
    if (this.#startedAt === undefined) throw new LiveBoundaryError('live_risk_epoch_mismatch');
    return this.#startedAt;
  }
  private fresh(): number {
    const now = this.now(), started = this.startedAt;
    if (!Number.isSafeInteger(now) || now < started || now - started > this.maxAgeMs) throw new LiveBoundaryError('live_risk_stale');
    return Math.max(1, this.maxAgeMs - (now - started));
  }
  private async decode(response: Response, type: string): Promise<unknown> {
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new LiveBoundaryError('live_risk_provider_unavailable'); }
    const value = await boundedLiveRead(() => readInfoJson(response, type, (type === 'allPerpMetas' ? 8 : 2) * 1024 * 1024), this.fresh());
    this.fresh();
    return value;
  }
  /** Sends one wave: the bodies not read yet in this epoch, together. The
   * first wave starts the epoch clock (as it is dispatched). */
  wave(bodies: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    const fresh = [...new Map(bodies.map(body => [keyOf(body), body])).entries()].filter(([key]) => !this.#memo.has(key));
    if (!fresh.length) return Promise.resolve();
    const begin = () => { this.#startedAt ??= this.now(); this.#begin(); };
    const responses = this.spend(liveInfoWeights(fresh.map(([, body]) => body))).then(() => this.send(fresh.map(([, body]) => body), begin));
    const settled = responses.then(list => { if (list.length !== fresh.length) throw new LiveBoundaryError('live_risk_provider_unavailable'); return list; });
    fresh.forEach(([key, body], index) => {
      const value = settled.then(list => this.decode(list[index]!, String(body.type)));
      void value.catch(() => undefined);
      this.#memo.set(key, value);
    });
    return settled.then(() => undefined);
  }
  /** One read's value: from this epoch's wave, or sent alone now. */
  async get(body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const key = keyOf(body);
    if (!this.#memo.has(key)) await this.wave([body]);
    const value = await this.#memo.get(key)!;
    this.fresh();
    return structuredClone(value);
  }
  /** Reads `bodies` anew (never from the memo) and requires each to equal
   * this epoch's first read of it: nothing changed while it was observed. */
  async unchanged(bodies: readonly Readonly<Record<string, unknown>>[], code: string): Promise<void> {
    const before = await Promise.all(bodies.map(body => this.get(body)));
    await this.spend(liveInfoWeights(bodies));
    const responses = await this.send(bodies, () => undefined);
    const after = await Promise.all(responses.map((response, index) => this.decode(response, String(bodies[index]!.type))));
    if (after.length !== before.length || after.some((value, index) => !isDeepStrictEqual(value, before[index]))) throw new LiveBoundaryError(code);
  }
}
