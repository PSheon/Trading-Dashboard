import type { OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';
import { WALLET_NETWORKS, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { Dec } from '../common/decimal/dec.js';
import { readInfoJson } from '../hyperliquid/response-validation.js';
import { HyperliquidAllDexsAccountSource, type LiveAllDexsAccountEvidence, type LiveAllDexsAccountSource } from './live/live-account-ws-source.js';
import { boundedLiveRead, LIVE_DEX_NAME, MAX_LIVE_PERP_DEXES } from './live/live-market-resolver.js';
import { address, LiveBoundaryError } from './live/wallet-authorization.js';
import { accountModeDigest } from './copy-account-mode.repository.js';
import type { AccountModeAbsenceOptions, AccountModeAbsenceProof, AccountModeAbsenceReader, AccountModeAbsenceTurn } from './copy-account-mode.service.js';
import type { HyperliquidGlobalTransport } from '../hyperliquid/hyperliquid-global-transport.js';
import { HyperliquidBudgetWait, LIVE_RESERVE_WAIT_MS, sharedCapacityWait, type LiveBudget, type LiveReserveOptions } from '../hyperliquid/hyperliquid-budget-wait.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const zero = decimal.refine(v => Dec.from(v).eq(0));
const summary = z.object({ accountValue: decimal, totalRawUsd: decimal, totalNtlPos: zero, totalMarginUsed: zero });
const stateSchema = z.object({ marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: zero,
  withdrawable: decimal, time: integer, assetPositions: z.array(z.unknown()).max(0) });
const dexSchema = z.array(z.object({ name: z.string().regex(LIVE_DEX_NAME).max(40) }).nullable()).min(1).max(MAX_LIVE_PERP_DEXES);
const fail = (): never => { throw new LiveBoundaryError('account_mode_absence_unproven'); };
function unique(values: readonly string[]) { if (new Set(values).size !== values.length) fail(); }
function fresh(at: number, now: number) { if (!Number.isSafeInteger(at) || at <= 0 || at > now || now - at > 5000) fail(); }

/** Provider weight of one absence proof: perpDexs 20, spotClearinghouseState
 * 2, extraAgents 20, the all-venue WS read 40 (local scheduling only), and
 * the final perpDexs 20. */
export const ACCOUNT_MODE_ABSENCE_WEIGHT = 102;
/** The shared all-venue source serves one read at a time, at most one a second. */
const SOURCE_SPACING_MS = 1_000;

/** Bootstrap evidence proves empty exposure only; default balances never
 * become standard equity/margin. Every actual perp venue must be observed.
 * One all-venue source serves every user of this process: a proof waits for
 * its turn (`turn`) before its clock starts, instead of being refused. */
export class HyperliquidAccountModeAbsenceReader implements AccountModeAbsenceReader, OnModuleDestroy {
  private readonly source: LiveAllDexsAccountSource;
  private tail: Promise<void> = Promise.resolve();
  private lastReadAt = 0;
  constructor(private readonly network: HyperliquidNetwork, private readonly acquire: LiveBudget, private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now, source?: LiveAllDexsAccountSource, private readonly global?: HyperliquidGlobalTransport) {
    this.source = source ?? new HyperliquidAllDexsAccountSource(now, undefined, network);
  }
  onModuleDestroy() { this.source.close?.(); }
  /** Waits (at most `maxWaitMs`) for this process's all-venue source: the
   * proofs before it to finish and a second since the last one. Taken
   * before any evidence clock starts; released when the proof's read is over. */
  async turn({ signal, maxWaitMs = LIVE_RESERVE_WAIT_MS }: LiveReserveOptions = {}): Promise<AccountModeAbsenceTurn> {
    signal?.throwIfAborted();
    let done!: () => void;
    const mine = new Promise<void>(resolve => { done = resolve; }), prior = this.tail;
    this.tail = prior.then(() => mine);
    let released = false;
    const release = () => { if (!released) { released = true; done(); } };
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new HyperliquidBudgetWait(maxWaitMs, 'local_budget')), Math.max(1, maxWaitMs));
        abort = () => reject(signal!.reason); signal?.addEventListener('abort', abort, { once: true });
        void prior.then(resolve);
      });
      const spacing = this.lastReadAt + SOURCE_SPACING_MS - this.now();
      if (spacing > 0) await new Promise(resolve => setTimeout(resolve, Math.min(spacing, SOURCE_SPACING_MS)));
      signal?.throwIfAborted();
      return { release };
    } catch (error) {
      // Gave up waiting: the turn passes on as soon as it comes.
      void prior.then(release);
      throw error;
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }
  async prove(accountAddress: string, options: AccountModeAbsenceOptions = {}): Promise<Readonly<AccountModeAbsenceProof>> {
    const { signal } = options;
    let turn = options.turn, reading: Promise<LiveAllDexsAccountEvidence> | undefined;
    try {
      const user = address(accountAddress);
      const readAccount = this.source.readAccount;
      if (!readAccount) return fail();
      // Paid for and queued before the clock starts (or by the caller).
      if (!options.prepaid) await this.acquire(ACCOUNT_MODE_ABSENCE_WEIGHT, { signal });
      turn ??= await this.turn({ signal });
      let started = 0;
      const startClock = () => { signal?.throwIfAborted(); started = this.now(); fresh(started, started); return AbortSignal.timeout(5000); };
      const remaining = () => { fresh(started, this.now()); return Math.max(1, 5000 - (this.now() - started)); };
      const check = (value: unknown) => {
        fresh(started, this.now());
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (row.user !== undefined && (typeof row.user !== 'string' || address(row.user) !== user) || row.network !== undefined && row.network !== this.network) fail();
        }
        return value;
      };
      const send = (bodies: readonly Record<string, unknown>[], meterWaitMs: number, bound: () => AbortSignal) => this.global
        ? this.global.fetchInfoBatch(WALLET_NETWORKS[this.network].infoUrl, bodies, { maxWaitMs: meterWaitMs, signal, onDispatch: bound })
        : (() => { const timeout = bound(); return Promise.all(bodies.map(body => this.fetcher(WALLET_NETWORKS[this.network].infoUrl, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }))); })();
      const answers = async (responses: Response[]) => Promise.all(responses.map(async response => {
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); fail(); }
        return check(await boundedLiveRead(() => readInfoJson(response, 'mode absence evidence', 2 * 1024 * 1024), remaining));
      }));
      // One meter charge for the first three reads; the clock starts as they go out.
      const meterWaitMs = options.prepaid ? 0 : LIVE_RESERVE_WAIT_MS;
      const first = await boundedLiveRead(() => send([{ type: 'perpDexs' }, { type: 'spotClearinghouseState', user }, { type: 'extraAgents', user }], meterWaitMs, startClock), meterWaitMs + 5000);
      const [rawDexes, spot, agents] = await answers(first);
      const list = dexSchema.parse(rawDexes);
      if (list[0] !== null) fail();
      const dexes = ['', ...list.flatMap(row => row ? [row.name] : [])]; unique(dexes);
      // Existing arbitrary agent authority and spot-held collateral are outside
      // the newly dedicated dormant bootstrap this action is allowed to change.
      z.array(z.unknown()).max(0).parse(agents);
      const balances = z.object({ portfolioMarginEnabled: z.literal(false).optional(), balances: z.array(z.object({
        coin: z.string().min(1).max(80), token: integer, total: zero, hold: zero,
      })).max(10000) }).parse(spot).balances;
      unique(balances.map(b => String(b.token))); unique(balances.map(b => b.coin));
      signal?.throwIfAborted();
      this.lastReadAt = this.now();
      const proof = structuredClone(await boundedLiveRead(() => {
        reading = readAccount.call(this.source, user, dexes, remaining(), signal); return reading;
      }, remaining));
      if (proof.state.network !== this.network || address(proof.state.accountAddress) !== user || proof.orders.network !== this.network || address(proof.orders.accountAddress) !== user) fail();
      for (const at of [proof.state.observedAt, proof.orders.observedAt, proof.orders.completedAt]) fresh(at, this.now());
      if (proof.orders.completedAt < proof.orders.observedAt) fail();
      const aggregate = z.object({ user: z.string(), clearinghouseStates: z.array(z.tuple([z.string().max(40), stateSchema])).max(MAX_LIVE_PERP_DEXES) }).parse(proof.state.data);
      if (address(aggregate.user) !== user) fail(); unique(aggregate.clearinghouseStates.map(([dex]) => dex));
      const rawStates = (proof.state.data as { clearinghouseStates: [string, Record<string, unknown>][] }).clearinghouseStates;
      for (const [, state] of rawStates) {
        if (state.user !== undefined && (typeof state.user !== 'string' || address(state.user) !== user) || state.network !== undefined && state.network !== this.network) fail();
      }
      if (aggregate.clearinghouseStates.length !== dexes.length || aggregate.clearinghouseStates.some(([dex]) => !dexes.includes(dex))) fail();
      for (const [, state] of aggregate.clearinghouseStates) fresh(state.time, this.now());
      const orders = z.object({ requestedDexes: z.array(z.string()).max(MAX_LIVE_PERP_DEXES), venues: z.array(z.object({
        dex: z.string(), user: z.string(), observedAt: integer, receivedAt: integer, orders: z.array(z.unknown()).max(0),
      })).max(MAX_LIVE_PERP_DEXES) }).parse(proof.orders);
      unique(orders.requestedDexes); unique(orders.venues.map(v => v.dex));
      if (orders.requestedDexes.length !== dexes.length || orders.venues.length !== dexes.length ||
          orders.requestedDexes.some(dex => !dexes.includes(dex)) || orders.venues.some(v => !dexes.includes(v.dex))) fail();
      for (const venue of orders.venues) {
        if (address(venue.user) !== user || venue.receivedAt < venue.observedAt || venue.observedAt < proof.orders.observedAt || venue.receivedAt > proof.orders.completedAt) fail();
        fresh(venue.observedAt, this.now()); fresh(venue.receivedAt, this.now());
      }
      const [finalRaw] = await answers(await boundedLiveRead(() => send([{ type: 'perpDexs' }], Math.max(0, Math.min(LIVE_RESERVE_WAIT_MS, remaining() - 2_000)), () => AbortSignal.timeout(remaining())), remaining));
      const finalDexes = dexSchema.parse(finalRaw);
      if (JSON.stringify(finalDexes) !== JSON.stringify(list)) fail();
      const observedAt = Math.min(started, proof.state.observedAt, proof.orders.observedAt, ...aggregate.clearinghouseStates.map(([, s]) => s.time)), completedAt = this.now();
      fresh(observedAt, completedAt);
      return Object.freeze({ network: this.network, accountAddress: user, observedAt, completedAt, dexes: Object.freeze(dexes),
        sourceDigest: accountModeDigest({ user, list, spot, agents, proof, started, completedAt }), complete: true as const, empty: true as const });
    } catch (error) {
      // Weight or the source not available yet: nothing was proven or refused.
      const wait = sharedCapacityWait(error);
      if (wait) throw wait;
      return fail();
    } finally {
      // The source is free once its read is over, even when this proof gave up first.
      if (turn) { if (reading) void reading.then(turn.release, turn.release); else turn.release(); }
    }
  }
}
