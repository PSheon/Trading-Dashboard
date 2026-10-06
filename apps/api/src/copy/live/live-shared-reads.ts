import { isDeepStrictEqual } from 'node:util';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { boundedLiveRead } from './live-market-resolver.js';
import { LiveBoundaryError } from './wallet-authorization.js';

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
    private readonly maxAgeMs = 5000, private readonly acquire?: (weight: number) => Promise<unknown>) {}
  /** Pays for reads ahead (before the clock starts): no budget wait later. */
  async pay(weight: number): Promise<void> {
    if (!this.acquire || weight <= 0) return;
    await boundedLiveRead(() => this.acquire!(weight), 5000);
    this.paidWeight += weight; this.#credit += weight;
  }
  /** Each send is paid from what was paid ahead, or acquired now. */
  private async spend(weight: number): Promise<void> {
    this.sentWeight += weight;
    const short = weight - this.#credit;
    this.#credit = Math.max(0, this.#credit - weight);
    if (short > 0) await this.pay(short).then(() => { this.#credit -= short; });
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
    const responses = this.spend(liveInfoWeights(fresh.map(([, body]) => body))).then(() => {
      if (this.batch && fresh.length > 1 && fresh.length <= 16) return this.batch(fresh.map(([, body]) => body), begin);
      begin();
      return Promise.all(fresh.map(([, body]) => boundedLiveRead(() => this.fetcher(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(this.fresh()) }), this.fresh())));
    });
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
    const send = async (): Promise<Response[]> => this.batch && bodies.length > 1 && bodies.length <= 16 ? this.batch(bodies, () => undefined)
      : Promise.all(bodies.map(body => boundedLiveRead(() => this.fetcher(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(this.fresh()) }), this.fresh())));
    const responses = await send();
    const after = await Promise.all(responses.map((response, index) => this.decode(response, String(bodies[index]!.type))));
    if (after.length !== before.length || after.some((value, index) => !isDeepStrictEqual(value, before[index]))) throw new LiveBoundaryError(code);
  }
}
