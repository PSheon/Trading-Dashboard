import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { HyperliquidLiveSourceClient, LiveSourceReadResult } from '../copy-live-source.client.js';
import type { CopyLiveSourceRepository } from '../copy-live-source.repository.js';
import type { UnitOfWork } from '../../db/unit-of-work.js';
import { UNHELD_REJECTED, type LiveExecutionRecord } from '../live/live-execution.js';
import type { LiveExecutionHooks, LiveExecutionRequest } from '../live/live-execution-runtime.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceDigest, liveSourceEvidenceDetail } from '../live/copy-live-source-evidence.js';
import { liveSourceExecutionAttempt, liveSourceExecutionCloid } from '../live/copy-live-leg-attempt.js';
import { describeUnexpected, errorCode } from '../../runtime/safe-error-text.js';
import { TERMINAL_STATES, type LiveQuarantineOutcome, type LiveSettleOutcome, type LiveSettleRequest } from './copy-live-settler.js';
import { SETTLEMENT_NEEDS_OWNER, SettlementRetries, type SettlementVerdict } from './settlement-retries.js';
import { SettlementPendingLog } from './settlement-pending-log.js';
import { MERGED_REASON, UNSENT_RETRY, type CopyLiveWorkerRepository, type DispatchRow, type LiveMandateWork, type LiveStreamWork } from './copy-live-worker.repository.js';
import { legEvent, legTransitioned, type LiveLegEvent, type LiveLegRow, type LiveLegWrite } from '../live/live-leg-event.js';
import { openNotionalCeiling, planAdjustments, type PendingLeg } from './copy-live-adjustments.js';
import { MAX_ACCUMULATE_MS } from '../live/copy-live-source-planner.js';
import type { WatchedMainnetSource } from './watched-mainnet-source.js';
import type { FastMainnetSource } from './fast-mainnet-source.js';
import { minOrderNotional } from '../min-order-notional.js';
import { Dec } from '../../common/decimal/dec.js';
import { HyperliquidBudgetWait } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { classify, LIVE_CHARGE_UNOWNED, liveRetryDelayMs, unownedLiveChargeAlert } from '../live/error-class.js';
import { budgetConsumer } from '../../hyperliquid/request-budgeter.service.js';
import { LiveReadComparisonError } from '../live/live-shared-reads.js';
import { LiveRiskBusyError, liveRiskBusyDetail } from '../live/postgres-live-risk-scope.js';

/** One source read's result, for the logs. */
interface IngestOutcome { fast: boolean; fills: number; kind: string; state: string; through: number | null }
/** A kick's signal half, timed (trade → read → ingested → enqueued). */
interface SignalTiming {
  started: number; read: { asked: number; sentAt: number; answeredAt: number } | null;
  ingest: IngestOutcome | null; ingestedAt: number; enqueuedAt: number;
}
interface LiveExecutor { execute(request: LiveExecutionRequest): Promise<LiveExecutionRecord> }
export interface LiveEngineDependencies {
  /** HYPERLIQUID_NETWORK; part of every order identity `<network>:<account>:<cloid>`. */
  readonly network: HyperliquidNetwork;
  readonly repository: CopyLiveWorkerRepository;
  readonly sources: CopyLiveSourceRepository;
  readonly uow: UnitOfWork;
  readonly watched: WatchedMainnetSource;
  /** Testnet leaders only (a testnet copy of a testnet address). */
  readonly testnetSource: HyperliquidLiveSourceClient;
  readonly runtime: (hooks: Pick<LiveExecutionHooks, 'onExchange'>) => LiveExecutor;
  readonly settler: { settle(request: LiveSettleRequest): Promise<LiveSettleOutcome>;
    /** Its retries are over (SETTLEMENT_RETRY_POLICY): the order goes to its owner (CopyLiveSettler.quarantine). */
    quarantine?(request: LiveSettleRequest, reason: string): Promise<LiveQuarantineOutcome> };
  /** Retain a committed settlement observation for reporting; never a permit. */
  readonly settlementObservation?: (key: string) => Promise<unknown>;
  /** One-click setups; run before funded generations start, so a new one starts this pass. */
  readonly setups?: { tick(): Promise<number> };
  /** Keeps one order's need free on the shared meter while copies run
   * (HyperliquidGlobalTransport.standbyLive with the heaviest order these
   * generations can send now: liveStandbyNeed). */
  readonly standby?: (mandates: readonly LiveMandateWork[]) => Promise<void>;
  /** Owner stop requests (cancel, close, flat, return); after the legs. */
  readonly stopper?: { tick(): Promise<void> };
  readonly log?: (message: string) => void;
  /** An ALERT line (logged at error level). */
  readonly alert?: (message: string) => void;
  /** Info-level timing lines (order sent). */
  readonly trace?: (message: string) => void;
  /** One structured `copy_leg` event per dispatch-row transition (live/live-leg-event.ts), beside the prose lines. */
  readonly event?: (event: LiveLegEvent) => void;
  /** A mainnet leader's account value (ratio denominator, cached); used to
   * hold an open too small for the exchange until more legs join it. */
  readonly leaderEquity?: (leader: string) => Promise<string | null>;
  /** Realtime mainnet source for COPY_LIVE_FAST_SOURCE leaders; read on a
   * kick, and by the pass while the trade feed is down. */
  readonly fast?: {
    readonly source: Pick<FastMainnetSource, 'read' | 'witness' | 'followUp' | 'nextReadAt' | 'graceMs'> & Partial<Pick<FastMainnetSource, 'lastTiming' | 'readOutcome'>>;
    readonly leaders: 'all' | ReadonlySet<string>;
    /** Whether the trade feed (kicks) is up; leaders are polled while it is not. */
    readonly feedUp?: () => boolean;
  };
}
interface LiveEngineOptions {
  /** Min interval per stream between testnet-leader REST polls (two worst-case
   * 120-weight reads; COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS, 3000 in the harness). */
  readonly testnetSourceIntervalMs: number;
  /** A mainnet read stops this long before now, so the watcher can confirm. */
  readonly sourceLagMs: number;
  /** Work per pass stops once this much time has gone. */
  readonly passBudgetMs: number;
  /** Max wait for more adds to an open too small for the exchange (default and max MAX_ACCUMULATE_MS). */
  readonly accumulateMs?: number;
  /** A kick's order half starts no work after this (default KICK_BUDGET_MS), so the pass isn't held up. */
  readonly kickBudgetMs?: number;
  /** Feed down: min interval between pass reads of a fast-source leader (default FAST_SOURCE_FEED_DOWN_POLL_MS). */
  readonly fastPollMs?: number;
}
export const DEFAULT_ENGINE_OPTIONS: LiveEngineOptions = { testnetSourceIntervalMs: TESTNET_SOURCE_INTERVAL_MS, sourceLagMs: SOURCE_LAG_MS, passBudgetMs: PASS_BUDGET_MS, fastPollMs: FAST_SOURCE_FEED_DOWN_POLL_MS };

/** HIP-3 (builder-deployed dex) fee scope cannot be proven (live-risk-provider):
 * refused at enqueue, before any evidence read spends weight. */
const HIP3_REFUSAL = 'live_market_hip3_unsupported';
const isHip3 = (coin: string) => coin.includes(':');
/** Wait before a failed first submission's next attempt; shared with the stop
 * pass (live/error-class.ts liveRetryDelayMs). */
export function retryDelayMs(error: unknown): number { return liveRetryDelayMs(error); }
/** Refusals no retry can change; anything else retries until the signal ages
 * out. Leverage above the cap is set before an open (live-leverage-update.ts),
 * so a refusal still citing it, or a rejected update, is final. */
const PERMANENT = new Set(['live_source_price_deviation', 'live_budget_over_capacity', 'below_min_notional', 'live_risk_adoption_unproven', 'live_market_unknown',
  'live_account_unsupported_role', 'live_account_unsupported_abstraction', 'unattempted_expired', 'live_risk_provider_fee_scope_unproven', HIP3_REFUSAL,
  'live_risk_leverage', 'live_risk_leverage_margin', 'live_leverage_update_rejected',
  // A control-refused unsent open must never queue ahead of reductions or catch up after resume.
  'platform_paused', 'user_paused', 'strategy_paused', 'platform_reduce_only', 'user_reduce_only', 'strategy_reduce_only']);
/** Copy trading off (general.copyTradingEnabled) refuses an unsent open for
 * good; a close still goes (safety exit). */
const PERMANENT_OPEN = new Set(['live_risk_platform_disabled']);
/** Started and active or paused. A pause refuses opens (submit) but still mirrors closes. */
export const mirrorsLeader = (m: LiveMandateWork) => m.activated && (m.strategyStatus === 'active' || m.strategyStatus === 'paused');
/** A refused close whose follower had nothing (left) to close. */
const FOLLOWER_ALREADY_FLAT = new Set(['no_follower_position', 'position_closed_by_owner', 'copy_stopping']);
/** Held when its follower notional could be under this much more than the minimum. */
const HOLD_HEADROOM = '1.1';
export { describeUnexpected, safeErrorText } from '../../runtime/safe-error-text.js';
import { LIVE_STANDBY_RENEW_MS, SHARED_CAPACITY_RETRY_MS } from '../../config/constants/hyperliquid.js';
import { SOURCE_STUCK_ALERT_MS } from '../../config/constants/alerts.js';
import { ABSTRACTION_ATTEMPT_LIMIT, CLOSE_ATTEMPT_LIMIT, MAX_LIVE_LEG_ATTEMPTS } from '../../config/constants/limits.js';
import { FAST_SOURCE_FEED_DOWN_POLL_MS, HOLD_MARGIN_MS, KICK_BUDGET_MS, PASS_BUDGET_MS, PLANNING_MARGIN_MS, SOURCE_LAG_MS, TESTNET_SOURCE_INTERVAL_MS, TESTNET_SOURCE_RETRY_MS } from '../../config/constants/timings.js';
import { liveSourceAdmission } from '../live/postgres-live-risk-authority.js';
const reasonOf = (error: unknown) => errorCode(error);
/** A source read's failure for the log: its code, and which evidence check refused it (if one did). */
const sourceReason = (error: unknown) => [reasonOf(error), liveSourceEvidenceDetail(error)].filter(Boolean).join(' ');

/**
 * One copy pass: start funded generations, ingest leader fills, enqueue legs,
 * then work open legs (submit, reconcile, settle). Restart-safe: the journal
 * holds the order identity (cloid, nonce); an attempted order is only reconciled, never re-sent.
 */
export class CopyLiveEngine {
  private readonly lastTestnetRead = new Map<string, number>();
  private readonly testnetSourceRetryAt = new Map<string, number>();
  /** Failed testnet source reads in a row, per stream (retryTestnetSoon). */
  private readonly testnetFailures = new Map<string, number>();
  /** A leg's next first-submission attempt after a failed one (retryDelayMs). */
  private readonly legRetryAt = new Map<string, number>();
  private readonly lastFastRead = new Map<string, number>();
  private readonly ingesting = new Set<string>();
  /** Why an order's settlement is still pending (rate-limited per order). */
  private readonly pendingSettlements = new SettlementPendingLog(message => this.deps.log?.(message), () => this.now());
  /** Failed settlement passes per order (SETTLEMENT_RETRY_POLICY). */
  private readonly settlementRetries: SettlementRetries;
  private readonly deps: LiveEngineDependencies;
  /** The leader of each generation worked (for the leg events: work() notes it before any row write). */
  private readonly leaders = new Map<string, string>();
  constructor(deps: LiveEngineDependencies, private readonly options: LiveEngineOptions = DEFAULT_ENGINE_OPTIONS,
    private readonly now: () => number = Date.now) {
    this.settlementRetries = new SettlementRetries(() => this.now());
    this.deps = { ...deps, repository: this.eventing(deps.repository) };
  }

  /**
   * Every single-row write of the engine goes through repository.update (CAS):
   * the one that moved the row and changed its state or reason is a `copy_leg`
   * event, exactly once, whichever method wrote it. The multi-row writes
   * (merge, dissolve, record) emit theirs where they are made.
   */
  private eventing(repository: CopyLiveWorkerRepository): CopyLiveWorkerRepository {
    const update: CopyLiveWorkerRepository['update'] = async (read, patch) => {
      const moved = await repository.update(read, patch);
      if (moved) this.legMoved(read, this.leaders.get(read.mandateId) ?? null, patch);
      return moved;
    };
    return new Proxy(repository, { get: (target, property, receiver) => property === 'update' ? update : Reflect.get(target, property, receiver) });
  }
  /** Emits the row's transition, if `write` is one (a write that changed neither state nor reason is not). */
  private legMoved(row: LiveLegRow, leader: string | null, write: LiveLegWrite): void {
    if (this.deps.event && legTransitioned(row, write)) this.deps.event(legEvent(row, leader, write, this.now()));
  }

  /** Source evidence only, beside a blocked order/settlement pass: no setup,
   * activation, dispatch, signing or settlement runs here. */
  async pollTestnetSources(): Promise<void> {
    if (this.deps.network !== 'testnet') return;
    const mandates = await this.deps.repository.mandates(this.now());
    await this.standby(mandates);
    const eligible = mandates.filter(m =>
      m.sourceNetwork === 'testnet' && mirrorsLeader(m));
    // Active streams only, but every unexpired generation's cursor decides whether coverage can restart.
    for (const stream of this.deps.repository.streams(eligible)) {
      try { await this.ingest(stream, mandates); }
      catch (error) { this.deps.log?.(`source ${stream.network}:${stream.leaderAddress} not read: ${sourceReason(error)}`); }
    }
  }

  /** When the shared meter's standby was last renewed (LIVE_STANDBY_RENEW_MS). */
  private standbyAt = Number.NEGATIVE_INFINITY;
  /** While a copy mirrors its leader, one order's need is kept free on the
   * shared meter (deps.standby): its first order never waits for
   * background's charges to expire. A failure is logged, never fatal. */
  private async standby(mandates: readonly LiveMandateWork[]): Promise<void> {
    if (!this.deps.standby || !mandates.some(mirrorsLeader) || this.now() - this.standbyAt < LIVE_STANDBY_RENEW_MS) return;
    this.standbyAt = this.now();
    try { await this.deps.standby(mandates); } catch (error) { this.deps.log?.(`live standby not recorded: ${reasonOf(error)}`); }
  }

  async tick(): Promise<void> {
    const started = this.now();
    if (this.deps.setups) {
      try { await budgetConsumer('copy.setup', () => this.deps.setups!.tick()); }
      catch (error) { this.deps.log?.(`setups kept for the next pass: ${reasonOf(error)}`); }
    }
    let mandates = await this.deps.repository.mandates(started);
    if ((await this.deps.repository.activateFunded(mandates, started)).length) mandates = await this.deps.repository.mandates(this.now());
    await this.standby(mandates);
    const streams = this.deps.repository.streams(mandates), current = new Set(streams.map(stream => `${stream.network}:${stream.leaderAddress}`));
    // A stream no copy reads any more ends its stuck episode: copied again later, it starts a fresh one.
    for (const key of this.notReadySince.keys()) if (!current.has(key)) { this.notReadySince.delete(key); this.stuckAlerted.delete(key); }
    for (const stream of streams) {
      // Without kicks (feed down), a fast-source leader is polled.
      const poll = this.fastLeader(stream) && this.deps.fast!.feedUp?.() === false &&
        started - (this.lastFastRead.get(stream.leaderAddress) ?? 0) >= (this.options.fastPollMs ?? FAST_SOURCE_FEED_DOWN_POLL_MS);
      try { await budgetConsumer('copy.source', () => this.ingest(stream, mandates, poll)); }
      catch (error) { this.deps.log?.(`source ${stream.network}:${stream.leaderAddress} not read: ${sourceReason(error)}`); }
      try { await this.watchStuck(stream); } catch (error) { this.deps.log?.(`source ${stream.network}:${stream.leaderAddress} not watched: ${reasonOf(error)}`); }
    }
    const limit = await this.deps.repository.signalAgeLimitMs();
    const held = await this.prepareWork(mandates.filter(mirrorsLeader));
    const byId = new Map(mandates.map(m => [m.mandateId, m]));
    for (const row of await this.deps.repository.open()) {
      if (this.now() - started > this.options.passBudgetMs) break;
      if (held.has(row.id)) continue;
      try { await budgetConsumer('copy.order', () => this.work(row, byId.get(row.mandateId) ?? null, limit)); }
      catch (error) { this.deps.log?.(`leg ${row.id} kept for the next pass: ${reasonOf(error)}`); }
    }
    // Leader flat but follower may still hold some (IOC close partly filled, or
    // unsendable): the single-position closer (stopper's pass) closes the rest.
    for (const m of mandates.filter(row => row.activated && row.strategyStatus !== 'stopping' && row.strategyStatus !== 'stopped')) {
      try { await budgetConsumer('copy.flat', () => this.reconcileFlat(m)); }
      catch (error) { this.deps.log?.(`flat positions of ${m.mandateId} not reconciled: ${reasonOf(error)}`); }
    }
    if (this.deps.stopper) {
      try { await budgetConsumer('copy.stop', () => this.deps.stopper!.tick()); }
      catch (error) { this.deps.log?.(`stops kept for the next pass: ${reasonOf(error)}`); }
    }
  }

  /** Whether this stream's signal may come from the fast source. */
  fastLeader(stream: Pick<LiveStreamWork, 'network' | 'leaderAddress'>): boolean {
    const fast = this.deps.fast;
    return stream.network === 'mainnet' && !!fast && (fast.leaders === 'all' || fast.leaders.has(stream.leaderAddress));
  }

  /** Notes a feed trade; returns when to kick its leader (a fill is certified
   * once graceMs old, and the leader's reads come no closer than graceMs:
   * FastMainnetSource.witness), or null for a watched-source leader. */
  witness(leader: string, tid: number, time: number): number | null {
    if (!this.fastLeader({ network: 'mainnet', leaderAddress: leader })) return null;
    return this.deps.fast!.source.witness(leader, tid, time);
  }
  /** After a kick: when the fast source next has something to certify. */
  followUp(leader: string): number | null {
    return this.fastLeader({ network: 'mainnet', leaderAddress: leader }) ? this.deps.fast!.source.followUp(leader) : null;
  }
  /** The earliest the fast source may read this leader again (0: now; a
   * kick due before it is moved there: one read per leader per G window). */
  nextReadAt(leader: string): number {
    return this.fastLeader({ network: 'mainnet', leaderAddress: leader }) ? this.deps.fast!.source.nextReadAt(leader) : 0;
  }

  /**
   * After the watcher's REST verification: a watcher fill inside both its
   * verified span and the stream's coverage that the stream lacks was missed.
   * It is stored now (its legs mostly refuse as expired), the stream goes to
   * `gap`, an alert is logged. Returns the missed tids.
   */
  async audit(leader: string): Promise<string[]> {
    const missed = await this.deps.repository.unmirroredFills(leader);
    if (!missed.length) return [];
    const iso = (at: number) => new Date(at).toISOString(), first = missed[0]!;
    this.deps.log?.(`ALERT copy source audit mainnet:${leader}: ${missed.length} fill(s) inside the stream's coverage [${iso(first.streamFrom)}, ${iso(first.streamThrough)}] ` +
      `and the watcher's verified span [${iso(first.verifiedFrom)}, ${iso(first.verifiedThrough)}] were never ingested: ` +
      `${missed.slice(0, 20).map(m => `${m.tid}@${iso(m.time)} ${m.coin}`).join(', ')}${missed.length > 20 ? ', ...' : ''}; stored now, stream set to gap (incomplete_coverage) until the next complete read`);
    const now = this.now(), from = Math.min(...missed.map(m => m.time)), to = Math.max(...missed.map(m => m.time));
    const stream = await this.deps.uow.run(tx => this.deps.sources.ensure(tx, leader, 'mainnet'));
    if (stream.state === 'quarantined') return missed.map(m => m.tid);
    const read = to <= now ? await this.deps.watched.read(leader, from, to) : null;
    if (read) {
      // Stored but certifying nothing: an incomplete read never moves coverage.
      const { sourceDigest: _digest, ...body } = { ...read, complete: false };
      await this.deps.uow.run(tx => this.deps.sources.apply(tx, stream.revision, { ...body, sourceDigest: liveSourceDigest(body) }, this.now()));
    } else await this.deps.uow.run(tx => this.deps.sources.fail(tx, leader, stream.revision, 'incomplete_coverage', this.now(), 'mainnet'));
    return missed.map(m => m.tid);
  }

  /** The trade feed saw this leader trade: read, enqueue and work its copies'
   * legs now. Setups, activations and stops stay with the regular pass. */
  async kick(leader: string): Promise<void> {
    if (!await this.signal(leader)) return;
    await this.workLeader(leader);
  }

  /**
   * A kick's signal half: read fills (fast source), enqueue new legs. Safe to
   * run beside a pass or an order in flight (reads are CAS-guarded, enqueue is
   * idempotent). Null when the leader has no fast-source copy.
   */
  async signal(leader: string): Promise<SignalTiming | null> {
    const started = this.now();
    const mandates = (await this.deps.repository.mandates(started)).filter(m => m.sourceNetwork === 'mainnet' && m.leaderAddress === leader);
    const streams = this.deps.repository.streams(mandates).filter(stream => this.fastLeader(stream));
    // No copy of this leader left: nothing reads its stream again, so no gap follow-up either.
    if (!streams.length) { this.noteFastOutcome({ network: 'mainnet', leaderAddress: leader }, false); return null; }
    let outcome: IngestOutcome | null = null;
    for (const stream of streams) {
      try { outcome = await this.ingest(stream, mandates, true); }
      catch (error) { this.deps.log?.(`source ${stream.network}:${stream.leaderAddress} not read: ${sourceReason(error)}`); }
    }
    const ingestedAt = this.now();
    for (const m of mandates.filter(mirrorsLeader)) {
      try { await this.enqueue(m); } catch (error) { this.deps.log?.(`legs of ${m.mandateId} not enqueued: ${reasonOf(error)}`); }
    }
    return { started, read: this.deps.fast?.source.lastTiming?.get(leader) ?? null, ingest: outcome, ingestedAt, enqueuedAt: this.now() };
  }

  /** A kick's order half: merge and work this leader's copies' legs (serialised with passes). */
  async workLeader(leader: string): Promise<void> {
    const started = this.now();
    const mandates = (await this.deps.repository.mandates(started)).filter(m => m.sourceNetwork === 'mainnet' && m.leaderAddress === leader);
    if (!mandates.length) return;
    const limit = await this.deps.repository.signalAgeLimitMs();
    const held = await this.prepareWork(mandates.filter(mirrorsLeader));
    const byId = new Map(mandates.map(m => [m.mandateId, m]));
    for (const row of await this.deps.repository.open(100, [...byId.keys()])) {
      // A kick works this leader's fresh legs, briefly: the rest waits for the pass.
      if (this.now() - started > (this.options.kickBudgetMs ?? KICK_BUDGET_MS)) break;
      if (held.has(row.id)) continue;
      try { await budgetConsumer('copy.order', () => this.work(row, byId.get(row.mandateId) ?? null, limit)); }
      catch (error) { this.deps.log?.(`leg ${row.id} kept for the next pass: ${reasonOf(error)}`); }
    }
  }

  /** Extends a stream's proven coverage to (almost) now; `fast` tries the fast source first. */
  async ingest(stream: LiveStreamWork, mandates: readonly LiveMandateWork[], fast = false): Promise<IngestOutcome | null> {
    // Mainnet retains its existing CAS-protected feed/poll concurrency. A
    // throw (ensure, restart, the read, apply) while a gap follow-up is open
    // counts as a gap read: its next look backs off and ends at the expiry.
    if (stream.network !== 'testnet') {
      try { return await this.ingestOriginal(stream, mandates, fast); }
      catch (error) { if (fast) this.noteFastOutcome(stream, true); throw error; }
    }
    const key = `${stream.network}:${stream.leaderAddress}`;
    if (this.ingesting.has(key)) return null;
    this.ingesting.add(key);
    try { return await this.ingestOriginal(stream, mandates, fast); }
    finally { this.ingesting.delete(key); }
  }

  private async ingestOriginal(stream: LiveStreamWork, mandates: readonly LiveMandateWork[], fast: boolean): Promise<IngestOutcome | null> {
    const { network, leaderAddress } = stream, key = `${network}:${leaderAddress}`, now = this.now();
    if (network === 'testnet' && now < (this.testnetSourceRetryAt.get(key)
      ?? (this.lastTestnetRead.get(key) ?? 0) + this.options.testnetSourceIntervalMs)) return null;
    let current = await this.deps.uow.run(tx => this.deps.sources.ensure(tx, leaderAddress, network));
    // Quarantined: no read brings it back, so no gap follow-up either.
    if (current.state === 'quarantined') { this.noteFastOutcome(stream, false); return null; }
    const earliest = mandates.filter(m => m.sourceNetwork === network && m.leaderAddress === leaderAddress).reduce((min, m) => Math.min(min, m.cursor.getTime()), Infinity);
    // Coverage ending before every cursor restarts at the earliest cursor instead of reading the gap.
    if (current.coverageThrough && current.coverageThrough.getTime() < earliest - 1) {
      const restarted = await this.deps.uow.run(tx => this.deps.sources.restart(tx, leaderAddress, network, current.revision, now));
      // No read this time: an open gap follow-up backs off instead of firing again at once (ingest notes a throw the same way).
      if (restarted.kind !== 'recorded') { if (fast) this.noteFastOutcome(stream, true); return null; }
      current = restarted.stream;
    }
    const from = current.coverageThrough ? current.coverageThrough.getTime() + 1 : earliest;
    const to = Math.min(now - this.options.sourceLagMs, from + 10 * 60_000);
    if (!Number.isFinite(from) || to < from) { if (fast) this.noteFastOutcome(stream, true); return null; }
    if (network === 'testnet') {
      this.lastTestnetRead.set(key, now);
      this.testnetSourceRetryAt.delete(key);
    }
    let result: LiveSourceReadResult | null = null, viaFast = false;
    if (fast && this.fastLeader(stream)) {
      this.lastFastRead.set(leaderAddress, now);
      try { result = await this.deps.fast!.source.read(leaderAddress, from); viaFast = result !== null; }
      catch (error) { this.deps.log?.(`fast source ${leaderAddress} not read: ${sourceReason(error)}`); }
      // A fast read that threw or certified nothing counts as a gap read: its follow-up backs off (and ends).
      if (!viaFast) this.noteFastOutcome(stream, true);
    }
    if (!result) {
      if (network === 'mainnet') result = await this.deps.watched.read(leaderAddress, from, to);
      else {
        try { result = await this.deps.testnetSource.read({ leaderAddress, from, to, maxRequests: 8 }); }
        catch (error) {
          // Only initial admission throws this wait (later failures become
          // incomplete reads): retry the same cursor when admitted, keeping the shared-IP backoff.
          if (error instanceof HyperliquidBudgetWait && Number.isFinite(error.retryMs))
            this.testnetSourceRetryAt.set(key, this.now() + Math.max(error.retryMs,
              error.reason === 'shared_capacity' ? SHARED_CAPACITY_RETRY_MS : 1000));
          else this.retryTestnetSoon(key);
          throw error;
        }
      }
    }
    if (!result) return null; // The watcher has not proven this span yet.
    const read = result;
    let applied: Awaited<ReturnType<CopyLiveSourceRepository['apply']>>;
    try { applied = await this.deps.uow.run(tx => this.deps.sources.apply(tx, current.revision, read, this.now())); }
    catch (error) { if (network === 'testnet') this.retryTestnetSoon(key); throw error; }
    if (network === 'testnet') {
      if (applied.stream.state === 'gap') this.retryTestnetSoon(key); else this.testnetFailures.delete(key);
    }
    if (applied.stream.state === 'gap' && applied.stream.lastIssue !== current.lastIssue)
      this.deps.log?.(`source ${key} in gap (${applied.stream.lastIssue}): read [${new Date(read.from).toISOString()}, ${new Date(read.to).toISOString()}] ${viaFast ? 'fast' : 'watched'}, ` +
        `fresh ${read.fresh}, complete ${read.complete}, ${read.completedAt - read.observedAt} ms`);
    // A fast read that left the stream in gap is followed up G after it (the
    // kick's follow-up), not at the leader's next trade; any read (the watched
    // source's too) that leaves it out of gap ends the follow-up.
    if (viaFast || applied.stream.state !== 'gap') this.noteFastOutcome(stream, applied.stream.state === 'gap');
    return { fast: viaFast, fills: read.fills.length, kind: applied.kind, state: applied.stream.state, through: applied.stream.coverageThrough?.getTime() ?? null };
  }

  /** Tells the fast source what the leader's stream did (FastMainnetSource.readOutcome), for fast-source leaders. */
  private noteFastOutcome(stream: Pick<LiveStreamWork, 'network' | 'leaderAddress'>, gap: boolean): void {
    if (this.fastLeader(stream)) this.deps.fast!.source.readOutcome?.(stream.leaderAddress, gap);
  }

  /** Since when a leader's stream has not been `ready` (watchStuck), by `<network>:<leader>`. */
  private readonly notReadySince = new Map<string, number>();
  /** Streams alerted as stuck in their current episode. */
  private readonly stuckAlerted = new Set<string>();
  /**
   * A stream not `ready` (gap, unproven, quarantined) holds its copies' opens,
   * and closes whose fill lies beyond the proven coverage, with no bound of
   * their own (live_risk_source_not_ready waits spend no attempt): after
   * SOURCE_STUCK_ALERT_MS of it, `ALERT copy source stuck`, once per episode.
   */
  private async watchStuck(stream: LiveStreamWork): Promise<void> {
    const key = `${stream.network}:${stream.leaderAddress}`, row = await this.deps.repository.stream(stream.network, stream.leaderAddress);
    if (!row || row.state === 'ready') { this.notReadySince.delete(key); this.stuckAlerted.delete(key); return; }
    const now = this.now(), since = this.notReadySince.get(key) ?? now;
    this.notReadySince.set(key, since);
    if (now - since < SOURCE_STUCK_ALERT_MS || this.stuckAlerted.has(key)) return;
    this.stuckAlerted.add(key);
    this.deps.alert?.(`ALERT copy source stuck ${JSON.stringify({ source: key, state: row.state, lastIssue: row.lastIssue, notReadyMs: now - since,
      coverageThrough: row.coverageThrough?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() })}`);
  }

  /** After a failed testnet read (thrown, refused, or gap): retry after
   * TESTNET_SOURCE_RETRY_MS, doubling per consecutive failure, capped at the
   * poll interval (gate run 9, 2026-10-14). */
  private retryTestnetSoon(key: string): void {
    const failures = (this.testnetFailures.get(key) ?? 0) + 1;
    this.testnetFailures.set(key, failures);
    const delay = Math.min(this.options.testnetSourceIntervalMs, TESTNET_SOURCE_RETRY_MS * 2 ** Math.min(failures - 1, 16));
    this.testnetSourceRetryAt.set(key, Math.max(this.testnetSourceRetryAt.get(key) ?? 0, this.now() + delay));
  }

  /** Enqueues and merges each copy's legs; returns the legs held back this pass. */
  private async prepareWork(mandates: readonly LiveMandateWork[]): Promise<Set<string>> {
    const held = new Set<string>();
    for (const m of mandates) {
      await this.enqueue(m);
      try { for (const id of await this.merge(m)) held.add(id); }
      catch (error) { this.deps.log?.(`legs of ${m.mandateId} not merged: ${reasonOf(error)}`); }
    }
    return held;
  }

  /**
   * Same-coin waiting legs become one adjustment per run (copy-live-adjustments.ts),
   * led by the newest leg (freshest signal). Ratio sizing only (a fixed amount
   * is spent once per trade). Returns legs held back as too small.
   */
  async merge(m: LiveMandateWork): Promise<string[]> {
    if (m.sizingMode !== 'ratio') return [];
    const keyOf = (row: Pick<DispatchRow, 'mandateId' | 'sourceFillId' | 'leg'>) => `${this.deps.network}:${m.accountAddress}:${liveSourceExecutionCloid(row.mandateId, row.sourceFillId, row.leg)}`;
    const rows = await this.deps.repository.mergeable(m.mandateId, keyOf);
    if (!rows.length) return [];
    const legs: PendingLeg[] = [];
    for (const { dispatch, fill } of rows) {
      let canonical: ReturnType<typeof canonicalLiveSourceLegs>;
      try { canonical = canonicalLiveSourceLegs(decodeLiveSourceFill(fill)); } catch { continue; }
      const own = canonical.find(leg => leg.leg === dispatch.leg);
      if (!own) continue;
      legs.push({ id: dispatch.id, sourceFillId: dispatch.sourceFillId, coin: dispatch.coin, leg: dispatch.leg, sign: own.sign, size: own.size, px: fill.px,
        leaderTime: dispatch.leaderTime.getTime(), tid: BigInt(fill.tid), flip: canonical.length > 1, belowMinimum: dispatch.reason === 'below_min_notional' });
    }
    const limits = await this.deps.repository.limits(), minimum = minOrderNotional(limits).mul(HOLD_HEADROOM);
    const equity = m.sourceNetwork === 'mainnet' && m.budgetUsd && this.deps.leaderEquity && legs.some(leg => leg.leg === 'open')
      ? await this.deps.leaderEquity(m.leaderAddress).catch(() => null) : null;
    // Every merged leg must still be a fresh signal when its order is planned.
    const windowMs = Math.max(0, Math.min(this.options.accumulateMs ?? MAX_ACCUMULATE_MS, limits.maxSignalAgeSeconds * 1000 - PLANNING_MARGIN_MS));
    const plan = planAdjustments(legs, this.now(), windowMs,
      run => { const ceiling = equity && m.budgetUsd ? openNotionalCeiling(run, m.budgetUsd, equity) : null; return ceiling !== null && ceiling.lt(minimum); });
    const byId = new Map(rows.map(({ dispatch }) => [dispatch.id, dispatch]));
    const refused = async (ids: ReadonlySet<string>, reason: 'below_min_notional' | 'merged_signal_expired') => {
      for (const id of await this.deps.repository.refusePending([...ids], reason)) this.legMoved(byId.get(id)!, m.leaderAddress, { state: 'refused', reason });
    };
    if (plan.expired.size) await refused(plan.expired, 'merged_signal_expired');
    if (plan.refused.size) await refused(plan.refused, 'below_min_notional');
    for (const run of plan.merges) {
      const lead = run.legs.at(-1)!, members = run.legs.slice(0, -1);
      if (await this.deps.repository.merge({ id: lead.id, mandateId: m.mandateId }, members.map(leg => leg.id)))
        for (const member of members) this.legMoved(byId.get(member.id)!, m.leaderAddress, { state: 'refused', reason: MERGED_REASON });
    }
    return [...plan.held];
  }

  /** One work row per leg of each new leader fill. */
  async enqueue(m: LiveMandateWork): Promise<void> {
    const rows = await this.deps.repository.newFills(m);
    const insert = rows.flatMap(row => {
      const base = { mandateId: m.mandateId, userId: m.userId, strategyId: m.strategyId, accountId: m.accountId, sourceFillId: row.id, coin: row.coin,
        leaderTime: row.providerTime, receivedAt: row.receivedAt };
      let legs: ReturnType<typeof canonicalLiveSourceLegs>;
      try { legs = canonicalLiveSourceLegs(decodeLiveSourceFill(row)); } catch { legs = []; }
      if (!legs.length) return [{ ...base, id: `${m.mandateId}|${row.id}|open`, leg: 'open' as const, state: 'refused' as const, reason: 'no_copyable_leg' }];
      if (isHip3(row.coin)) return legs.map(leg => ({ ...base, id: `${m.mandateId}|${row.id}|${leg.leg}`, leg: leg.leg, state: 'refused' as const, reason: HIP3_REFUSAL }));
      return legs.map(leg => ({ ...base, id: `${m.mandateId}|${row.id}|${leg.leg}`, leg: leg.leg }));
    });
    // A leg planned refused (nothing copyable, HIP-3) never waited: its one transition is pending → refused at enqueue.
    for (const row of await this.deps.repository.record(insert))
      if (row.state === 'refused') this.legMoved({ ...row, state: 'pending', reason: null }, m.leaderAddress, { state: 'refused', reason: row.reason });
  }

  async work(row: DispatchRow, m: LiveMandateWork | null, signalAgeMs: number): Promise<void> {
    const mandate = m ?? await this.mandateOf(row);
    if (!mandate) return;
    this.leaders.set(mandate.mandateId, mandate.leaderAddress);
    if (row.state === 'pending') {
      // Original order, or the attempt after one released as never sent (copy-live-leg-attempt.ts).
      const attempt = this.pendingAttempt(row, mandate);
      if (attempt === null) { await this.deps.repository.update(row, { state: 'refused', reason: 'live_leg_attempt_unproven' }); return; }
      const key = this.attemptKey(row, mandate, attempt);
      // A journal under this key means an earlier pass reached the exchange: reconcile only.
      const journal = await this.deps.repository.journalState(key);
      if (journal !== null) { await this.deps.repository.update(row, { state: 'submitted', executionKey: key }); return; }
      return this.submit(row, mandate, signalAgeMs, attempt);
    }
    const state = row.executionKey ? await this.deps.repository.journalState(row.executionKey) : null;
    if (state === null) return;
    const attempt = this.attemptOf(row, mandate, row.executionKey!);
    // Reconcile the row's own attempt; a key matching no attempt falls back to attempt 0.
    if (!TERMINAL_STATES.has(state)) { await this.execute(row, mandate, undefined, attempt ?? 0); return; }
    const key = row.executionKey!, request: LiveSettleRequest = { userId: row.userId, accountId: row.accountId, accountAddress: mandate.accountAddress,
      sourceNetwork: mandate.sourceNetwork, leaderAddress: mandate.leaderAddress, key };
    // A failed settlement pass is not tried again before its retry is due; once its retries are over its order goes to its owner.
    if (!this.settlementRetries.due(key)) return;
    let outcome: LiveSettleOutcome;
    if (this.settlementRetries.owed(key) && this.deps.settler.quarantine) outcome = await this.settlementToOwner(request, null);
    else {
      try { outcome = await this.deps.settler.settle(request); }
      catch (error) {
        const verdict = this.settlementRetries.failed(key, error);
        if (classify(error).code === LIVE_CHARGE_UNOWNED) this.deps.alert?.(unownedLiveChargeAlert('settlement', { key, accountId: row.accountId, stage: 'settle' }));
        if (verdict.kind !== 'needs_owner' || !this.deps.settler.quarantine) throw error;
        outcome = await this.settlementToOwner(request, verdict);
      }
      const verdict = outcome.kind === 'pending' ? this.settlementRetries.outcome(key, outcome) : (this.settlementRetries.done(key), null);
      if (verdict?.kind === 'needs_owner' && this.deps.settler.quarantine) outcome = await this.settlementToOwner(request, verdict);
    }
    this.pendingSettlements.note(key, outcome);
    if (outcome.kind === 'released') {
      await this.deps.repository.update(row, { state: 'settled', settledAt: new Date(this.now()), reason: null });
      try { await this.deps.settlementObservation?.(row.executionKey!); }
      catch { this.deps.log?.('Committed settlement observation could not be retained; scheduled reporting will retry'); }
    }
    else if (outcome.kind === 'unplaced' && outcome.unsent) await this.afterUnsent(row, mandate, signalAgeMs);
    else if (outcome.kind === 'unplaced') await this.deps.repository.update(row, { state: 'refused', reason: 'exchange_order_never_placed' });
    else if (outcome.kind === 'quarantine' || outcome.kind === 'unsent') await this.deps.repository.update(row, { state: 'refused', reason: outcome.reason.slice(0, 80) });
    else await this.deps.repository.update(row, { reason: outcome.reason.slice(0, 80) });
  }

  /** A settlement whose retries are over: its order quarantined for its owner,
   * with an ALERT (naming the account's flat stop when there is one). */
  private async settlementToOwner(request: LiveSettleRequest, verdict: Extract<SettlementVerdict, { kind: 'needs_owner' }> | null): Promise<LiveSettleOutcome> {
    const outcome = await this.deps.settler.quarantine!(request, SETTLEMENT_NEEDS_OWNER);
    this.settlementRetries.done(request.key);
    if (outcome.kind === 'released') return outcome;
    this.deps.alert?.(`ALERT settlement_needs_owner ${JSON.stringify({ key: request.key, accountId: request.accountId, attempts: verdict?.attempts ?? null, lastCode: verdict?.code ?? null,
      reservation: outcome.reason, flatStop: outcome.flat ? { stopId: outcome.flat.stopId, flatDigest: outcome.flat.flatDigest, flatVerifiedAt: new Date(outcome.flat.flatVerifiedAt).toISOString() } : null })}`);
    return { kind: 'quarantine', reason: SETTLEMENT_NEEDS_OWNER };
  }

  /** The execution key of `attempt` of this leg on the copy's account. */
  private attemptKey(row: Pick<DispatchRow, 'mandateId' | 'sourceFillId' | 'leg'>, m: Pick<LiveMandateWork, 'accountAddress'>, attempt: number): string {
    return `${this.deps.network}:${m.accountAddress}:${liveSourceExecutionCloid(row.mandateId, row.sourceFillId, row.leg, attempt)}`;
  }
  /** Which attempt of this leg `key` is, or null when it is none of them. */
  private attemptOf(row: Pick<DispatchRow, 'mandateId' | 'sourceFillId' | 'leg'>, m: Pick<LiveMandateWork, 'accountAddress'>, key: string): number | null {
    const prefix = `${this.deps.network}:${m.accountAddress}:`;
    return key.startsWith(prefix) ? liveSourceExecutionAttempt(row.mandateId, row.sourceFillId, row.leg, key.slice(prefix.length)) : null;
  }
  /** A pending leg's next order: 0, or the one after the attempt it names. */
  private pendingAttempt(row: DispatchRow, m: LiveMandateWork): number | null {
    if (row.executionKey === null) return 0;
    const previous = this.attemptOf(row, m, row.executionKey);
    return previous !== null && previous + 1 < MAX_LIVE_LEG_ATTEMPTS ? previous + 1 : null;
  }
  /**
   * Order released as never sent: re-plan the leg as its next attempt (new
   * cloid, key, nonce; every submit gate again) if its signal is fresh (a close
   * never ages), it is not merged into another leg's order, and attempts <
   * MAX_LIVE_LEG_ATTEMPTS; else refuse. The lead of a merge (adjustmentId its
   * own id) is the order for itself and its members, so it is planned again
   * carrying them (execute reloads them); a member (refused
   * merged_into_adjustment) never gets here. Gate 13 (2026-10-17): a leader
   * open filled in two pieces merged into one order whose signing failed on
   * an empty budget; the lead was refused exchange_order_never_placed with
   * 55 s of signal left, and the follower never held the position the flip
   * then closed.
   */
  private async afterUnsent(row: DispatchRow, m: LiveMandateWork, signalAgeMs: number): Promise<void> {
    const previous = row.executionKey ? this.attemptOf(row, m, row.executionKey) : null;
    const fresh = row.leg !== 'open' || this.now() - row.leaderTime.getTime() <= signalAgeMs;
    const ownOrder = row.adjustmentId === null || row.adjustmentId === row.id;
    if (previous !== null && previous + 1 < MAX_LIVE_LEG_ATTEMPTS && ownOrder && fresh) {
      this.legRetryAt.delete(row.id);
      if (await this.deps.repository.update(row, { state: 'pending', reason: UNSENT_RETRY }))
        this.deps.log?.(`leg ${row.id}: attempt ${previous + 1} released as never sent; planning attempt ${previous + 2} of ${MAX_LIVE_LEG_ATTEMPTS}`);
      return;
    }
    await this.deps.repository.update(row, { state: 'refused', reason: 'exchange_order_never_placed' });
  }

  private async submit(row: DispatchRow, m: LiveMandateWork, signalAgeMs: number, attempt = 0): Promise<void> {
    // A fixed amount is claimed once per exchange trade, even across partial batches.
    if (row.leg === 'open' && await this.deps.repository.knownFixedOpenClaim(row, m)) {
      await this.deps.repository.update(row, { state: 'refused', reason: 'fixed_trade_already_claimed' }); return;
    }
    const now = this.now();
    // Only an open ages (CP-EXE-14-02). Refused as signal_expired, not as its
    // last failure, which is only logged (gate 2026-10-13).
    if (row.leg === 'open' && now - row.leaderTime.getTime() > signalAgeMs) {
      if (row.reason && row.reason !== UNSENT_RETRY) this.deps.log?.(`leg ${row.id} refused: signal_expired (source age ${now - row.leaderTime.getTime()} ms, ${row.attempts} attempt(s), last ${row.reason})`);
      await this.deps.repository.update(row, { state: 'refused', reason: 'signal_expired' }); return;
    }
    if (m.strategyStatus === 'stopping' || m.strategyStatus === 'stopped') {
      // The stop closes every position itself; no new leg of a stopping copy is sent.
      await this.deps.repository.update(row, { state: 'refused', reason: 'copy_stopping' }); return;
    }
    // Paused: an open is refused for good (no catch-up after resume); a close still mirrors.
    if (m.strategyStatus === 'paused' && row.leg === 'open') {
      await this.deps.repository.update(row, { state: 'refused', reason: 'strategy_paused' }); return;
    }
    // Paused: only a current generation's (active or paused) close proceeds; anything else waits.
    const closable = m.strategyStatus === 'paused' && (m.mandateState === 'active' || m.mandateState === 'paused');
    if (m.strategyStatus !== 'active' && !closable) return;
    if (row.leg === 'close' && await this.deps.repository.closedByOwner(row.mandateId, row.accountId, row.coin)) {
      await this.deps.repository.update(row, { state: 'refused', reason: 'position_closed_by_owner' }); return;
    }
    // Liquidated by Hyperliquid (CP-EXE-16): account quarantined, nothing sent.
    if (row.leg === 'close' && await this.deps.repository.liquidatedSinceOpen(row.mandateId, row.accountId, row.coin)) {
      await this.deps.repository.update(row, { state: 'refused', reason: 'position_liquidated' }); return;
    }
    if (row.leg === 'close' && !await this.deps.repository.everOpened(row.mandateId, row.coin)) {
      await this.deps.repository.update(row, { state: 'refused', reason: 'no_follower_position' }); return;
    }
    // A pending close request on the coin would close this open too: wait for it.
    if (row.leg === 'open' && await this.deps.repository.closeRequested(row.accountId, row.coin)) return;
    if (row.leg === 'open') {
      // A flip opens only after its close settled, or when the follower had
      // nothing to close (the planner then proves it flat, no close journaled).
      const close = await this.deps.repository.dispatch(`${row.mandateId}|${row.sourceFillId}|close`);
      const nothingToClose = close?.state === 'refused' && close.reason === 'no_follower_position';
      if (close?.state === 'refused' && !nothingToClose) { await this.deps.repository.update(row, { state: 'refused', reason: 'flip_close_not_settled' }); return; }
      if (close && close.state !== 'settled' && !nothingToClose) return;
    }
    // Leader order: an earlier waiting leg of the coin goes first.
    if (await this.deps.repository.earlierPending(row)) return;
    // Any unsettled order on the account would fail the generation proof: wait, not an attempt.
    if (await this.deps.repository.unsettledOnAccount(row)) return;
    // Honour retryDelayMs after a failed attempt.
    if ((this.legRetryAt.get(row.id) ?? 0) > this.now()) return;
    // The leader's stream does not admit the leg yet: wait, not an attempt.
    if (!await this.sourceReady(row, m)) return;
    await this.execute(row, m, row.leg === 'open' ? row.leaderTime.getTime() + signalAgeMs : undefined, attempt);
  }

  /**
   * Whether the leader's source stream admits this leg now (THE decision:
   * liveSourceAdmission, D10: `ready` admits every leg, `gap` a close only,
   * with its coverage from before the copy's cursor). One SQL read, before
   * any evidence is spent; the authority asks the same. While it does
   * not, the leg waits with the reason and no attempt is spent (Stage mainnet
   * 2026-10-22 18:02Z, strategy 14: a ~60 s gap cost a close nine counted
   * attempts; CLOSE_ATTEMPT_LIMIT would have refused it in a ~90 s one). The
   * wait is bounded: an open by its signal age (signal_expired), and the
   * stream recovers on its next complete read (the next pass, or a kick's
   * follow-up read G after the one that fell short: FastMainnetSource.readOutcome).
   * A close is not held here (D10): it goes on the copy's own fresh account
   * evidence while the stream is in gap; one the authority still refuses (a
   * stream unproven or quarantined, a fill beyond the proven coverage) waits
   * as the same `budget`-class wait, never a counted attempt.
   */
  private async sourceReady(row: DispatchRow, m: LiveMandateWork): Promise<boolean> {
    const stream = await this.deps.repository.stream(m.sourceNetwork, m.leaderAddress);
    // Held only for what the authority answers with a wait (live_risk_source_not_ready); an admitted leg goes, and a
    // refused one (no row, coverage starting after the copy's cursor) is the authority's to count
    // (live_risk_source_changed) as before D10, never held here (CI 2026-10-23, copy-live-network.spec: a cursor before
    // the coverage held the leg for ever).
    const admission = liveSourceAdmission(stream, row.leg, m.cursor, row.leaderTime);
    if (admission.verdict !== 'wait') return true; // a wait always has a stream row
    const reason = admission.code;
    if (row.reason !== reason) {
      this.deps.log?.(`leg ${row.id} waits: ${reason} (source ${m.sourceNetwork}:${m.leaderAddress} ${stream!.state}${stream!.lastIssue ? ` (${stream!.lastIssue})` : ''}); no attempt spent`);
      await this.deps.repository.update(row, { reason });
    }
    return false;
  }

  /** Submits or reconciles the leg's order; a first submission's budget wait ends at `signalDeadline`. */
  private async execute(row: DispatchRow, m: LiveMandateWork, signalDeadline?: number, attempt = 0): Promise<void> {
    const attemptedAt = this.now();
    const timing: { sentAt?: number; ackedAt?: number } = {}, first = row.firstAttemptAt ?? new Date(attemptedAt);
    const runtime = this.deps.runtime({ onExchange: event => { if (event.phase === 'request') timing.sentAt ??= event.at; else timing.ackedAt ??= event.at; } });
    try {
      const members = row.adjustmentId === row.id ? await this.deps.repository.members(row.id) : [];
      const record = await runtime.execute({ userId: row.userId, accountId: row.accountId, mandateId: row.mandateId, sourceFillId: row.sourceFillId, leg: row.leg,
        ...(members.length ? { members } : {}), ...(signalDeadline !== undefined ? { signalDeadline } : {}), ...(attempt ? { attempt } : {}) });
      const times = { ...(timing.sentAt ? { sentAt: new Date(timing.sentAt) } : {}), ...(timing.ackedAt ? { ackedAt: new Date(timing.ackedAt) } : {}) };
      if (record.errorCode === 'unattempted_expired' || record.errorCode === UNHELD_REJECTED) {
        const reason = record.errorCode === UNHELD_REJECTED ? (record.outcome?.reason ?? UNHELD_REJECTED).slice(0, 80) : 'unattempted_expired';
        await this.deps.repository.update(row, { state: 'refused', reason, executionKey: record.key, firstAttemptAt: first, attempts: row.attempts + 1 }); return;
      }
      this.legRetryAt.delete(row.id);
      await this.deps.repository.update(row, { state: 'submitted', executionKey: record.key, firstAttemptAt: first, attempts: row.attempts + 1, reason: null, ...times });
      if (row.state === 'pending') this.deps.trace?.(`Copy order ${row.id}${members.length ? ` (+${members.length} merged)` : ''}: received +${row.receivedAt.getTime() - row.leaderTime.getTime()}, ` +
        `first attempt +${first.getTime() - row.leaderTime.getTime()}, sent ${times.sentAt ? `+${times.sentAt.getTime() - row.leaderTime.getTime()}` : '-'} ms after the leader`);
    } catch (error) {
      const reason = reasonOf(error);
      // A `budget`-class wait (live/error-class.ts) that sent nothing is not an
      // attempt and never exhausts a close's limit (gate 2026-10-13).
      const waiting = classify(error).class === 'budget' && timing.sentAt === undefined;
      // The same wait as the row already shows (a stream still not ready, a lock
      // still busy): nothing new to log or write; only its next look is set.
      const repeated = waiting && row.state === 'pending' && row.reason === reason;
      if (repeated) { this.legRetryAt.set(row.id, this.now() + retryDelayMs(error)); return; }
      // The row keeps only the latest reason, so log each attempt (safe code only,
      // never the error or provider body).
      this.deps.log?.(`leg ${row.id} attempt ${row.attempts + 1} failed: ${reason}; ` +
        `elapsed ${Math.max(0, this.now() - attemptedAt)} ms, source age ${Math.max(0, this.now() - row.leaderTime.getTime())} ms, ` +
        `exchange started ${timing.sentAt !== undefined}` +
        (error instanceof LiveReadComparisonError ? `, changed reads ${error.changedReads.join(',')}` : '') +
        (error instanceof LiveRiskBusyError ? `, held by ${liveRiskBusyDetail(error)}` : ''));
      if (error instanceof HyperliquidBudgetWait) this.deps.log?.(`leg ${row.id} budget unavailable: ${error.reason}, retry ${error.retryMs} ms`);
      // A live charge nobody owned: a code defect at this site, never a retry (error-class.ts).
      if (reason === LIVE_CHARGE_UNOWNED) this.deps.alert?.(unownedLiveChargeAlert('copy_leg', { legId: row.id, leg: row.leg, attempt: row.attempts + 1, stage: timing.sentAt !== undefined ? 'exchange' : 'evidence' }));
      // Stored as live_execution_failed; log what it really was.
      const unexpected = describeUnexpected(error);
      if (unexpected) this.deps.log?.(`leg ${row.id} failed unexpectedly: ${unexpected}`);
      const times = timing.sentAt ? { sentAt: new Date(timing.sentAt), ...(timing.ackedAt ? { ackedAt: new Date(timing.ackedAt) } : {}) } : {};
      // A POST that began leaves an exchange-side outcome to reconcile.
      const key = this.attemptKey(row, m, attempt);
      const journal = await this.deps.repository.journalState(key);
      if (row.state === 'pending' && journal !== null && journal !== 'prepared') {
        await this.deps.repository.update(row, { state: 'submitted', executionKey: key, firstAttemptAt: first, attempts: row.attempts + 1, reason, ...times }); return;
      }
      // An unjournaled open below the minimum waits for more legs while its signal is young.
      const signalAgeMs = await this.deps.repository.signalAgeLimitMs();
      if (row.state === 'pending' && row.leg === 'open' && reason === 'below_min_notional' && journal === null &&
        this.now() - row.leaderTime.getTime() < Math.max(0, signalAgeMs - HOLD_MARGIN_MS)) {
        const members = await this.deps.repository.dissolve(row, row.attempts + 1);
        if (members) {
          this.legMoved(row, m.leaderAddress, { reason: 'below_min_notional', attempts: row.attempts + 1 });
          for (const member of members) this.legMoved(member, m.leaderAddress, { state: 'pending', reason: 'below_min_notional' });
        }
        return;
      }
      const attempts = waiting ? row.attempts : row.attempts + 1;
      // Right after a setup the exchange may still report the old mode (testnet 2026-10-12): final only at the limit.
      const transient = reason === 'live_account_unsupported_abstraction' && attempts < ABSTRACTION_ATTEMPT_LIMIT;
      const permanent = row.state === 'pending' && !waiting && !transient && (PERMANENT.has(reason) || row.leg === 'open' && PERMANENT_OPEN.has(reason) || row.leg === 'close' && (reason === 'no_follower_position' || attempts >= CLOSE_ATTEMPT_LIMIT));
      if (permanent || row.state !== 'pending') this.legRetryAt.delete(row.id);
      else this.legRetryAt.set(row.id, this.now() + retryDelayMs(error));
      await this.deps.repository.update(row, { ...(permanent ? { state: 'refused' as const } : {}), reason, firstAttemptAt: first, attempts, ...times });
    }
  }

  /**
   * Leader fully flat on a coin, follower maybe not (close refused, or settled
   * with an IOC carry left): request a reduce-only close. The closer reads the
   * account first and does nothing if already flat.
   */
  async reconcileFlat(m: Pick<LiveMandateWork, 'mandateId'>): Promise<number> {
    let requested = 0;
    for (const { row, fill, carry } of await this.deps.repository.latestByCoin(m.mandateId)) {
      if (row.leg !== 'close' || (row.state !== 'settled' && row.state !== 'refused')) continue;
      if (row.state === 'refused' && FOLLOWER_ALREADY_FLAT.has(row.reason ?? '')) continue;
      let legs: ReturnType<typeof canonicalLiveSourceLegs>;
      try { legs = canonicalLiveSourceLegs(decodeLiveSourceFill(fill)); } catch { continue; }
      const close = legs.find(leg => leg.leg === 'close');
      if (!close?.fraction || !Dec.from(close.fraction).eq(Dec.ONE) || legs.some(leg => leg.leg === 'open')) continue; // the leader is not flat
      if (row.state === 'settled' && !(carry !== null && Dec.from(carry).isPositive)) continue; // the close took it all
      if (!await this.deps.repository.everOpened(row.mandateId, row.coin)) continue;
      if (await this.deps.repository.requestFlatClose(row, new Date(this.now()))) {
        requested++;
        this.deps.log?.(`leader flat on ${row.coin}: closing what ${row.accountId} still holds (after ${row.id}, ${row.state}${row.reason ? ` ${row.reason}` : ''})`);
      }
    }
    return requested;
  }

  private async mandateOf(row: DispatchRow): Promise<LiveMandateWork | null> {
    // A stopped/expired generation still settles what it submitted.
    const mandate = await this.deps.repository.mandate(row.mandateId);
    if (!mandate) return null;
    return { mandateId: mandate.id, userId: mandate.userId, strategyId: mandate.strategyId, accountId: mandate.accountId, accountAddress: mandate.accountAddress,
      sourceNetwork: mandate.sourceNetwork, leaderAddress: mandate.leaderAddress, cursor: mandate.activationCursor ?? mandate.createdAt, expiresAt: mandate.expiresAt,
      strategyStatus: await this.deps.repository.strategyStatus(mandate.strategyId) ?? 'stopped', activated: true, activatedAt: null,
      mandateState: mandate.expiresAt.getTime() > this.now() ? mandate.state : 'expired' };
  }
}
