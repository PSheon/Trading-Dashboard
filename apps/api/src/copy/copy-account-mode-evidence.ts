import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';
import { WALLET_NETWORKS, type HyperliquidNetwork, safeNonnegativeIntSchema, unsignedDecimal18Schema } from '@trading-dashboard/shared/contracts';
import { Dec } from '../common/decimal/dec.js';
import { readInfoJson } from '../hyperliquid/response-validation.js';
import { safeErrorText } from '../runtime/safe-error-text.js';
import { extraAgentsSchema } from '../hyperliquid/info-schemas.js';
import { HyperliquidAllDexsAccountSource, type LiveAllDexsAccountEvidence, type LiveAllDexsAccountSource } from './live/live-account-ws-source.js';
import { boundedLiveRead, LIVE_DEX_NAME, MAX_LIVE_PERP_DEXES } from './live/live-market-resolver.js';
import { address, LiveBoundaryError } from './live/wallet-authorization.js';
import { accountModeDigest } from './copy-account-mode.repository.js';
import type { AccountModeAbsenceOptions, AccountModeAbsenceProof, AccountModeAbsenceReader, AccountModeAbsenceTurn } from './copy-account-mode.service.js';
import type { HyperliquidGlobalTransport } from '../hyperliquid/hyperliquid-global-transport.js';
import { SETUP_OWNER } from '../hyperliquid/hyperliquid-global-quota.js';
import { HyperliquidBudgetWait, sharedCapacityWait, type LiveBudget, type LiveReserveOptions } from '../hyperliquid/hyperliquid-budget-wait.js';
import { LIVE_RESERVE_WAIT_MS } from '../config/constants/hyperliquid.js';
import { SOURCE_SPACING_MS } from '../config/constants/timings.js';
import { ACCOUNT_MODE_ABSENCE_WEIGHT } from '../config/constants/weights.js';
import { liveEvidenceMaxAgeMs } from '../config/live-evidence-window.js';

const integer = safeNonnegativeIntSchema;
const decimal = unsignedDecimal18Schema;
const zero = decimal.refine(v => Dec.from(v).eq(0));
const summary = z.object({ accountValue: decimal, totalRawUsd: decimal, totalNtlPos: zero, totalMarginUsed: zero });
const stateSchema = z.object({ marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: zero,
  withdrawable: decimal, time: integer, assetPositions: z.array(z.unknown()).max(0) });
const dexSchema = z.array(z.object({ name: z.string().regex(LIVE_DEX_NAME).max(40) }).nullable()).min(1).max(MAX_LIVE_PERP_DEXES);
const fail = (): never => { throw new LiveBoundaryError('account_mode_absence_unproven'); };
/** Why an absence proof failed: the check, cause code, socket read timing, and any meter refusal. */
interface AccountModeAbsenceFailure {
  readonly check: string; readonly cause: string; readonly wsReadMs: number | null; readonly wsConnectRefused: boolean;
  readonly elapsedMs: number; readonly quota?: unknown;
}
/** account_mode_absence_unproven, with what failed (AccountModeAbsenceFailure). */
class AccountModeAbsenceUnproven extends LiveBoundaryError {
  constructor(readonly detail: AccountModeAbsenceFailure) { super('account_mode_absence_unproven'); }
}
/** The shared meter's socket refusals (reserveSocket): connect units, the
 * connection, subscription and user caps. */
const SOCKET_REFUSALS = new Set(['hyperliquid_quota_exhausted', 'hyperliquid_quota_connections', 'hyperliquid_quota_subscriptions', 'hyperliquid_quota_users', 'hyperliquid_quota_expired']);
const causeOf = (error: unknown): string => error instanceof LiveBoundaryError ? error.code : error instanceof z.ZodError ? 'schema' :
  error instanceof Error ? (error.name === 'Error' ? 'error' : error.name) : 'unknown';
function unique(values: readonly string[]) { if (new Set(values).size !== values.length) fail(); }
function fresh(at: number, now: number, network: HyperliquidNetwork) { if (!Number.isSafeInteger(at) || at <= 0 || at > now || now - at > liveEvidenceMaxAgeMs(network)) fail(); }


/** Proves empty exposure across every perp venue. One all-venue source per process: a proof waits
 * its `turn` before its clock starts instead of being refused. */
export class HyperliquidAccountModeAbsenceReader implements AccountModeAbsenceReader, OnModuleDestroy {
  private readonly source: LiveAllDexsAccountSource;
  private tail: Promise<void> = Promise.resolve();
  private lastReadAt = 0;
  constructor(private readonly network: HyperliquidNetwork, private readonly acquire: LiveBudget, private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now, source?: LiveAllDexsAccountSource, private readonly global?: HyperliquidGlobalTransport) {
    this.source = source ?? new HyperliquidAllDexsAccountSource(now, undefined, network);
  }
  onModuleDestroy() {
    void Promise.resolve(this.source.close?.())
      .catch((error: unknown) => new Logger('HyperliquidAccountModeAbsenceReader').warn(`all-venue source close failed: ${safeErrorText(error)}`));
  }
  /** Waits (≤ `maxWaitMs`) for the all-venue source, a second after the previous proof; taken before
   * any evidence clock, released when the read ends. */
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
        timer = setTimeout(() => reject(new HyperliquidBudgetWait(maxWaitMs, 'local_budget', { bucket: 'account_mode_absence_turn' })), Math.max(1, maxWaitMs));
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
    // Diagnostics: the check under way, and the socket read's timing.
    const begun = this.now();
    let step = 'admission', wsStarted: number | undefined, wsEnded: number | undefined;
    try {
      const user = address(accountAddress);
      const readAccount = this.source.readAccount;
      if (!readAccount) return fail();
      // Paid for and queued before the clock starts (or by the caller).
      if (!options.prepaid) await this.acquire(ACCOUNT_MODE_ABSENCE_WEIGHT, { signal });
      turn ??= await this.turn({ signal });
      let started = 0;
      const startClock = () => { signal?.throwIfAborted(); started = this.now(); fresh(started, started, this.network); const bound = AbortSignal.timeout(liveEvidenceMaxAgeMs(this.network)); options.consume?.(42); return bound; };
      const remaining = () => { fresh(started, this.now(), this.network); return Math.max(1, liveEvidenceMaxAgeMs(this.network) - (this.now() - started)); };
      const check = (value: unknown) => {
        fresh(started, this.now(), this.network);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (row.user !== undefined && (typeof row.user !== 'string' || address(row.user) !== user) || row.network !== undefined && row.network !== this.network) fail();
        }
        return value;
      };
      const send = (bodies: readonly Record<string, unknown>[], meterWaitMs: number, bound: () => AbortSignal) => this.global
        ? this.global.runDefaultOwner(SETUP_OWNER, () => this.global!.fetchInfoBatch(WALLET_NETWORKS[this.network].infoUrl, bodies, { maxWaitMs: meterWaitMs, signal, onDispatch: bound }))
        : (() => { signal?.throwIfAborted(); const timeout = bound(); return Promise.all(bodies.map(body => this.fetcher(WALLET_NETWORKS[this.network].infoUrl, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }))); })();
      const answers = async (responses: Response[]) => Promise.all(responses.map(async response => {
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); fail(); }
        return check(await boundedLiveRead(() => readInfoJson(response, 'mode absence evidence', 2 * 1024 * 1024), remaining));
      }));
      // One meter charge for the first three reads; the clock starts as they go out.
      const meterWaitMs = options.prepaid ? 0 : LIVE_RESERVE_WAIT_MS;
      step = 'first_batch';
      const first = await boundedLiveRead(() => send([{ type: 'perpDexs' }, { type: 'spotClearinghouseState', user }, { type: 'extraAgents', user }], meterWaitMs, startClock), meterWaitMs + liveEvidenceMaxAgeMs(this.network));
      const [rawDexes, spot, agents] = await answers(first);
      step = 'perp_dexs';
      const list = dexSchema.parse(rawDexes);
      if (list[0] !== null) fail();
      const dexes = ['', ...list.flatMap(row => row ? [row.name] : [])]; unique(dexes);
      // Extra agents or spot collateral are outside what this bootstrap may change.
      step = 'extra_agents';
      if (extraAgentsSchema.parse(agents).length) fail();
      step = 'spot_balances';
      const balances = z.object({ portfolioMarginEnabled: z.literal(false).optional(), balances: z.array(z.object({
        coin: z.string().min(1).max(80), token: integer, total: zero, hold: zero,
      })).max(10000) }).parse(spot).balances;
      unique(balances.map(b => String(b.token))); unique(balances.map(b => b.coin));
      signal?.throwIfAborted();
      this.lastReadAt = this.now();
      step = 'ws_read'; wsStarted = this.now();
      const proof = structuredClone(await boundedLiveRead(() => {
        const timeout = remaining(); signal?.throwIfAborted(); options.consume?.(40);
        reading = readAccount.call(this.source, user, dexes, timeout, signal); return reading;
      }, remaining));
      wsEnded = this.now(); step = 'ws_evidence';
      if (proof.state.network !== this.network || address(proof.state.accountAddress) !== user || proof.orders.network !== this.network || address(proof.orders.accountAddress) !== user) fail();
      for (const at of [proof.state.observedAt, proof.orders.observedAt, proof.orders.completedAt]) fresh(at, this.now(), this.network);
      if (proof.orders.completedAt < proof.orders.observedAt) fail();
      const aggregate = z.object({ user: z.string(), clearinghouseStates: z.array(z.tuple([z.string().max(40), stateSchema])).max(MAX_LIVE_PERP_DEXES) }).parse(proof.state.data);
      if (address(aggregate.user) !== user) fail(); unique(aggregate.clearinghouseStates.map(([dex]) => dex));
      const rawStates = (proof.state.data as { clearinghouseStates: [string, Record<string, unknown>][] }).clearinghouseStates;
      for (const [, state] of rawStates) {
        if (state.user !== undefined && (typeof state.user !== 'string' || address(state.user) !== user) || state.network !== undefined && state.network !== this.network) fail();
      }
      if (aggregate.clearinghouseStates.length !== dexes.length || aggregate.clearinghouseStates.some(([dex]) => !dexes.includes(dex))) fail();
      for (const [, state] of aggregate.clearinghouseStates) fresh(state.time, this.now(), this.network);
      const orders = z.object({ requestedDexes: z.array(z.string()).max(MAX_LIVE_PERP_DEXES), venues: z.array(z.object({
        dex: z.string(), user: z.string(), observedAt: integer, receivedAt: integer, orders: z.array(z.unknown()).max(0),
      })).max(MAX_LIVE_PERP_DEXES) }).parse(proof.orders);
      unique(orders.requestedDexes); unique(orders.venues.map(v => v.dex));
      if (orders.requestedDexes.length !== dexes.length || orders.venues.length !== dexes.length ||
          orders.requestedDexes.some(dex => !dexes.includes(dex)) || orders.venues.some(v => !dexes.includes(v.dex))) fail();
      for (const venue of orders.venues) {
        if (address(venue.user) !== user || venue.receivedAt < venue.observedAt || venue.observedAt < proof.orders.observedAt || venue.receivedAt > proof.orders.completedAt) fail();
        fresh(venue.observedAt, this.now(), this.network); fresh(venue.receivedAt, this.now(), this.network);
      }
      step = 'final_perp_dexs';
      const [finalRaw] = await answers(await boundedLiveRead(() => send([{ type: 'perpDexs' }], Math.max(0, Math.min(LIVE_RESERVE_WAIT_MS, remaining() - 2_000)), () => { const bound = AbortSignal.timeout(remaining()); options.consume?.(20); return bound; }), remaining));
      step = 'perp_dexs_unchanged';
      const finalDexes = dexSchema.parse(finalRaw);
      if (JSON.stringify(finalDexes) !== JSON.stringify(list)) fail();
      step = 'freshness';
      const observedAt = Math.min(started, proof.state.observedAt, proof.orders.observedAt, ...aggregate.clearinghouseStates.map(([, s]) => s.time)), completedAt = this.now();
      fresh(observedAt, completedAt, this.network);
      return Object.freeze({ network: this.network, accountAddress: user, observedAt, completedAt, dexes: Object.freeze(dexes),
        sourceDigest: accountModeDigest({ user, list, spot, agents, proof, started, completedAt }), complete: true as const, empty: true as const });
    } catch (error) {
      // Weight or the source not available yet: nothing was proven or refused.
      const wait = sharedCapacityWait(error);
      if (wait) throw wait;
      const cause = causeOf(error), wsReadMs = wsStarted === undefined ? null : (wsEnded ?? this.now()) - wsStarted;
      const quota = await this.global?.meterSnapshot().catch(() => undefined);
      const detail: AccountModeAbsenceFailure = { check: step, cause, wsReadMs, wsConnectRefused: step === 'ws_read' && SOCKET_REFUSALS.has(cause), elapsedMs: this.now() - begun, ...(quota ? { quota } : {}) };
      new Logger('HyperliquidAccountModeAbsenceReader').warn(`account_mode_absence_unproven ${JSON.stringify(detail)}`);
      throw new AccountModeAbsenceUnproven(detail);
    } finally {
      // The source is free once its read is over, even when this proof gave up first.
      if (turn) { if (reading) void reading.then(turn.release, turn.release); else turn.release(); }
    }
  }
}
