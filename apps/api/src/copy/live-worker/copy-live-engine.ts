import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { HyperliquidLiveSourceClient, LiveSourceReadResult } from '../copy-live-source.client.js';
import type { CopyLiveSourceRepository } from '../copy-live-source.repository.js';
import type { UnitOfWork } from '../../db/unit-of-work.js';
import { UNHELD_REJECTED, type LiveExecutionRecord } from '../live/live-execution.js';
import type { LiveExecutionHooks, LiveExecutionRequest } from '../live/live-execution-runtime.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceDigest } from '../live/copy-live-source-evidence.js';
import { liveSourceExecutionCloid } from '../live/postgres-live-preparation.js';
import { describeUnexpected, errorCode } from '../../runtime/safe-error-text.js';
import { TERMINAL_STATES, type LiveSettleOutcome, type LiveSettleRequest } from './copy-live-settler.js';
import type { CopyLiveWorkerRepository, DispatchRow, LiveMandateWork, LiveStreamWork } from './copy-live-worker.repository.js';
import { openNotionalCeiling, planAdjustments, type PendingLeg } from './copy-live-adjustments.js';
import { MAX_ACCUMULATE_MS } from '../live/copy-live-source-planner.js';
import type { WatchedMainnetSource } from './watched-mainnet-source.js';
import type { FastMainnetSource } from './fast-mainnet-source.js';
import { minOrderNotional } from '../min-order-notional.js';
import { Dec } from '../../common/decimal/dec.js';
import { HyperliquidBudgetWait, SHARED_CAPACITY_RETRY_MS } from '../../hyperliquid/hyperliquid-budget-wait.js';

/** One source read's result, for the logs. */
export interface IngestOutcome { fast: boolean; fills: number; kind: string; state: string; through: number | null }
/** A kick's signal half, timed (trade → read → ingested → enqueued). */
export interface SignalTiming {
  started: number; read: { asked: number; sentAt: number; answeredAt: number } | null;
  ingest: IngestOutcome | null; ingestedAt: number; enqueuedAt: number;
}
export interface LiveExecutor { execute(request: LiveExecutionRequest): Promise<LiveExecutionRecord> }
export interface LiveEngineDependencies {
  /** The deployment's network (HYPERLIQUID_NETWORK): every order's identity
   * (`<network>:<account>:<cloid>`) is on it. */
  readonly network: HyperliquidNetwork;
  readonly repository: CopyLiveWorkerRepository;
  readonly sources: CopyLiveSourceRepository;
  readonly uow: UnitOfWork;
  readonly watched: WatchedMainnetSource;
  /** Testnet leaders only (a testnet copy of a testnet address). */
  readonly testnetSource: HyperliquidLiveSourceClient;
  readonly runtime: (hooks: Pick<LiveExecutionHooks, 'onExchange'>) => LiveExecutor;
  readonly settler: { settle(request: LiveSettleRequest): Promise<LiveSettleOutcome> };
  /** Retain a committed settlement observation for reporting; never a permit. */
  readonly settlementObservation?: (key: string) => Promise<unknown>;
  /** One-click setups (credit → mode → agent → builder → generation), before
   * funded generations start, so a generation made now starts this pass. */
  readonly setups?: { tick(): Promise<number> };
  /** Owner stop requests (cancel, close, flat, return); after the legs. */
  readonly stopper?: { tick(): Promise<void> };
  readonly log?: (message: string) => void;
  /** Ordinary timing lines (order sent), at info level. */
  readonly trace?: (message: string) => void;
  /** A mainnet leader's account value (the ratio denominator, cached), to
   * hold an open too small for the exchange until more legs join it. */
  readonly leaderEquity?: (leader: string) => Promise<string | null>;
  /** The realtime mainnet source, for the leaders COPY_LIVE_FAST_SOURCE
   * names; read on a kick, and by the pass while the trade feed is down. */
  readonly fast?: {
    readonly source: Pick<FastMainnetSource, 'read' | 'witness' | 'followUp' | 'graceMs'> & Partial<Pick<FastMainnetSource, 'lastTiming'>>;
    readonly leaders: 'all' | ReadonlySet<string>;
    /** Whether the trade feed (the kicks) is up; polled while it is not. */
    readonly feedUp?: () => boolean;
  };
}
export interface LiveEngineOptions {
  /** Testnet-leader REST polls are costly (two worst-case 120-weight reads):
   * at most one per stream this often (COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS;
   * 3000 for the testnet harness). Mainnet leaders cost nothing extra. */
  readonly testnetSourceIntervalMs: number;
  /** A mainnet read stops this long before now, so the watcher can confirm. */
  readonly sourceLagMs: number;
  /** Work per pass stops once this much time has gone. */
  readonly passBudgetMs: number;
  /** An open too small for the exchange waits for the next adds at most this
   * long (default and maximum MAX_ACCUMULATE_MS). */
  readonly accumulateMs?: number;
  /** A kick's order half stops starting work after this long (default 8 s),
   * so the regular pass is never held up for long. */
  readonly kickBudgetMs?: number;
  /** While the trade feed is down, a fast-source leader is read by the pass
   * at most this often. */
  readonly fastPollMs?: number;
}
export const DEFAULT_ENGINE_OPTIONS: LiveEngineOptions = { testnetSourceIntervalMs: 60_000, sourceLagMs: 1_000, passBudgetMs: 20_000, fastPollMs: 7_500 };

/** A HIP-3 (builder-deployed dex) market: its fee scope cannot be proven
 * (live-risk-provider), so its legs are refused when they are enqueued,
 * before any evidence read spends weight. */
export const HIP3_REFUSAL = 'live_market_hip3_unsupported';
const isHip3 = (coin: string) => coin.includes(':');
/** Refusals that no retry can change. Everything else is retried until the
 * leader fill is older than the policy's signal age. The account's leverage
 * above the cap is set by the runtime before an open (live-leverage-update.ts):
 * a refusal still saying so, or an update the exchange rejected, is final. */
const PERMANENT = new Set(['live_source_price_deviation', 'live_budget_over_capacity', 'below_min_notional', 'live_risk_adoption_unproven', 'live_market_unknown',
  'live_account_unsupported_role', 'live_account_unsupported_abstraction', 'unattempted_expired', 'live_risk_provider_fee_scope_unproven', HIP3_REFUSAL,
  'live_risk_leverage', 'live_leverage_update_rejected',
  // A control-refused unsent open must never queue ahead of reductions or
  // catch up after resume. Historical journals remain on settlement instead.
  'platform_paused', 'user_paused', 'strategy_paused', 'platform_reduce_only', 'user_reduce_only', 'strategy_reduce_only']);
/** A merged order is planned within this long after its legs are merged
 * (evidence reads ~4 s): no leg merged older than the signal age less this. */
const PLANNING_MARGIN_MS = 15_000;
/** A refused close whose follower had nothing (left) to close. */
const FOLLOWER_ALREADY_FLAT = new Set(['no_follower_position', 'position_closed_by_owner', 'copy_stopping']);
/** A close has no age limit, but one that keeps failing is refused after this
 * many attempts (never an endless retry); a leader then flat closes the rest. */
export const CLOSE_ATTEMPT_LIMIT = 30;
/** A merged open the planner finds below the minimum goes back to waiting
 * only while its lead's signal has at least this long left (else refused). */
const HOLD_MARGIN_MS = 30_000;
/** Held when its follower notional could be under this much more than the minimum. */
const HOLD_HEADROOM = '1.1';
export { describeUnexpected, safeErrorText } from '../../runtime/safe-error-text.js';
const reasonOf = (error: unknown) => errorCode(error);

/**
 * One pass of copy execution on the deployment's network, in this order: start funded
 * generations, ingest leader fills, enqueue new legs, then work the open
 * legs (submit pending ones, reconcile unknown/resting ones from the
 * exchange, settle terminal ones). Every step is restart-safe: the
 * executor's journal holds the order identity (cloid, nonce) and never
 * re-sends an attempted order; a restarted worker only reconciles it.
 */
export class CopyLiveEngine {
  private readonly lastTestnetRead = new Map<string, number>();
  private readonly testnetSourceRetryAt = new Map<string, number>();
  private readonly lastFastRead = new Map<string, number>();
  private readonly ingesting = new Set<string>();
  constructor(private readonly deps: LiveEngineDependencies, private readonly options: LiveEngineOptions = DEFAULT_ENGINE_OPTIONS,
    private readonly now: () => number = Date.now) {}

  /** Source evidence only, beside a blocked order/settlement pass. No setup,
   * activation, dispatch work, signing or settlement authority runs here.
   * The ordinary pass still enqueues and executes with fresh original risk. */
  async pollTestnetSources(): Promise<void> {
    if (this.deps.network !== 'testnet') return;
    const mandates = await this.deps.repository.mandates(this.now());
    const eligible = mandates.filter(m =>
      m.sourceNetwork === 'testnet' && m.activated && m.strategyStatus === 'active');
    // Select active streams, but preserve every unexpired generation's
    // required cursor when deciding whether shared coverage can restart.
    for (const stream of this.deps.repository.streams(eligible)) {
      try { await this.ingest(stream, mandates); }
      catch (error) { this.deps.log?.(`source ${stream.network}:${stream.leaderAddress} not read: ${reasonOf(error)}`); }
    }
  }

  async tick(): Promise<void> {
    const started = this.now();
    if (this.deps.setups) {
      try { await this.deps.setups.tick(); }
      catch (error) { this.deps.log?.(`setups kept for the next pass: ${reasonOf(error)}`); }
    }
    let mandates = await this.deps.repository.mandates(started);
    if ((await this.deps.repository.activateFunded(mandates, started)).length) mandates = await this.deps.repository.mandates(this.now());
    for (const stream of this.deps.repository.streams(mandates)) {
      // Without kicks (feed down), a fast-source leader is polled.
      const poll = this.fastLeader(stream) && this.deps.fast!.feedUp?.() === false &&
        started - (this.lastFastRead.get(stream.leaderAddress) ?? 0) >= (this.options.fastPollMs ?? 7_500);
      try { await this.ingest(stream, mandates, poll); }
      catch (error) { this.deps.log?.(`source ${stream.network}:${stream.leaderAddress} not read: ${reasonOf(error)}`); }
    }
    const limit = await this.deps.repository.signalAgeLimitMs();
    const held = await this.prepareWork(mandates.filter(row => row.activated && row.strategyStatus === 'active'));
    const byId = new Map(mandates.map(m => [m.mandateId, m]));
    for (const row of await this.deps.repository.open()) {
      if (this.now() - started > this.options.passBudgetMs) break;
      if (held.has(row.id)) continue;
      try { await this.work(row, byId.get(row.mandateId) ?? null, limit); }
      catch (error) { this.deps.log?.(`leg ${row.id} kept for the next pass: ${reasonOf(error)}`); }
    }
    // A leader flat on a coin whose follower may still hold some of it (an
    // IOC close partly or not filled, or a close that could not be sent):
    // the single-position closer (run by the stopper's pass) closes the rest.
    for (const m of mandates.filter(row => row.activated && row.strategyStatus !== 'stopping' && row.strategyStatus !== 'stopped')) {
      try { await this.reconcileFlat(m); }
      catch (error) { this.deps.log?.(`flat positions of ${m.mandateId} not reconciled: ${reasonOf(error)}`); }
    }
    if (this.deps.stopper) {
      try { await this.deps.stopper.tick(); }
      catch (error) { this.deps.log?.(`stops kept for the next pass: ${reasonOf(error)}`); }
    }
  }

  /** Whether this stream's signal may come from the fast source. */
  fastLeader(stream: Pick<LiveStreamWork, 'network' | 'leaderAddress'>): boolean {
    const fast = this.deps.fast;
    return stream.network === 'mainnet' && !!fast && (fast.leaders === 'all' || fast.leaders.has(stream.leaderAddress));
  }

  /** Notes a trade the feed saw; returns when to kick its leader (a read
   * certifies a fill once it is G old), or null for a leader on the watched source. */
  witness(leader: string, tid: number, time: number): number | null {
    if (!this.fastLeader({ network: 'mainnet', leaderAddress: leader })) return null;
    this.deps.fast!.source.witness(leader, tid, time);
    return time + this.deps.fast!.source.graceMs + 100;
  }
  /** After a kick: when the fast source next has something to certify. */
  followUp(leader: string): number | null {
    return this.fastLeader({ network: 'mainnet', leaderAddress: leader }) ? this.deps.fast!.source.followUp(leader) : null;
  }

  /**
   * After the watcher verified a leader's fills over REST: every fill it
   * holds inside both its verified span and the copy stream's coverage
   * must be a source fill of the stream. One that is not was missed (a
   * certified span that was not complete): it is stored now, so its legs
   * are reconciled (most will be refused as expired), the stream goes to
   * `gap` and an alert is logged. Returns the missed tids.
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

  /**
   * A realtime signal: the trade feed saw this leader trade. Reads the
   * leader's fills (fast source), enqueues the new legs of its copies and
   * works their open legs, fresh pending legs first, in this one pass.
   * Setups, activations and stops stay with the regular pass.
   */
  async kick(leader: string): Promise<void> {
    if (!await this.signal(leader)) return;
    await this.workLeader(leader);
  }

  /**
   * The signal half of a kick: reads the leader's fills (fast source) and
   * enqueues its copies' new legs. It never waits for an order: the worker
   * runs it at once, beside a pass or an order in flight (a source read is
   * CAS-guarded and an enqueue idempotent). False when the leader has no
   * fast-source copy.
   */
  async signal(leader: string): Promise<SignalTiming | null> {
    const started = this.now();
    const mandates = (await this.deps.repository.mandates(started)).filter(m => m.sourceNetwork === 'mainnet' && m.leaderAddress === leader);
    const streams = this.deps.repository.streams(mandates).filter(stream => this.fastLeader(stream));
    if (!streams.length) return null;
    let outcome: IngestOutcome | null = null;
    for (const stream of streams) {
      try { outcome = await this.ingest(stream, mandates, true); }
      catch (error) { this.deps.log?.(`source ${stream.network}:${stream.leaderAddress} not read: ${reasonOf(error)}`); }
    }
    const ingestedAt = this.now();
    for (const m of mandates.filter(row => row.activated && row.strategyStatus === 'active')) {
      try { await this.enqueue(m); } catch (error) { this.deps.log?.(`legs of ${m.mandateId} not enqueued: ${reasonOf(error)}`); }
    }
    return { started, read: this.deps.fast?.source.lastTiming?.get(leader) ?? null, ingest: outcome, ingestedAt, enqueuedAt: this.now() };
  }

  /** The order half of a kick: merges and works this leader's copies' legs,
   * fresh pending legs first (one at a time with the passes). */
  async workLeader(leader: string): Promise<void> {
    const started = this.now();
    const mandates = (await this.deps.repository.mandates(started)).filter(m => m.sourceNetwork === 'mainnet' && m.leaderAddress === leader);
    if (!mandates.length) return;
    const limit = await this.deps.repository.signalAgeLimitMs();
    const held = await this.prepareWork(mandates.filter(row => row.activated && row.strategyStatus === 'active'));
    const byId = new Map(mandates.map(m => [m.mandateId, m]));
    for (const row of await this.deps.repository.open(100, [...byId.keys()])) {
      // A kick works this leader's fresh legs, briefly: the rest waits for the pass.
      if (this.now() - started > (this.options.kickBudgetMs ?? 8_000)) break;
      if (held.has(row.id)) continue;
      try { await this.work(row, byId.get(row.mandateId) ?? null, limit); }
      catch (error) { this.deps.log?.(`leg ${row.id} kept for the next pass: ${reasonOf(error)}`); }
    }
  }

  /** Extends one leader stream's proven coverage up to (almost) now; with
   * `fast`, from the fast source (the watched one when it has nothing). */
  async ingest(stream: LiveStreamWork, mandates: readonly LiveMandateWork[], fast = false): Promise<IngestOutcome | null> {
    // Mainnet retains its existing CAS-protected feed/poll concurrency.
    if (stream.network !== 'testnet') return this.ingestOriginal(stream, mandates, fast);
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
    if (current.state === 'quarantined') return null;
    const earliest = mandates.filter(m => m.sourceNetwork === network && m.leaderAddress === leaderAddress).reduce((min, m) => Math.min(min, m.cursor.getTime()), Infinity);
    // A span that no current generation needs (it ended before every active
    // cursor) restarts at the earliest cursor instead of reading the gap.
    if (current.coverageThrough && current.coverageThrough.getTime() < earliest - 1) {
      const restarted = await this.deps.uow.run(tx => this.deps.sources.restart(tx, leaderAddress, network, current.revision, now));
      if (restarted.kind !== 'recorded') return null;
      current = restarted.stream;
    }
    const from = current.coverageThrough ? current.coverageThrough.getTime() + 1 : earliest;
    const to = Math.min(now - this.options.sourceLagMs, from + 10 * 60_000);
    if (!Number.isFinite(from) || to < from) return null;
    if (network === 'testnet') {
      this.lastTestnetRead.set(key, now);
      this.testnetSourceRetryAt.delete(key);
    }
    let result: LiveSourceReadResult | null = null, viaFast = false;
    if (fast && this.fastLeader(stream)) {
      this.lastFastRead.set(leaderAddress, now);
      try { result = await this.deps.fast!.source.read(leaderAddress, from); viaFast = result !== null; }
      catch (error) { this.deps.log?.(`fast source ${leaderAddress} not read: ${reasonOf(error)}`); }
    }
    if (!result) {
      if (network === 'mainnet') result = await this.deps.watched.read(leaderAddress, from, to);
      else {
        try { result = await this.deps.testnetSource.read({ leaderAddress, from, to, maxRequests: 8 }); }
        catch (error) {
          // Only the initial admission can propagate this wait: the source
          // client catches subsequent channel failures as incomplete reads.
          // No provider evidence exists yet; retry the unchanged coverage
          // cursor after admission permits, retaining the shared-IP backoff.
          if (error instanceof HyperliquidBudgetWait && Number.isFinite(error.retryMs))
            this.testnetSourceRetryAt.set(key, this.now() + Math.max(error.retryMs,
              error.reason === 'shared_capacity' ? SHARED_CAPACITY_RETRY_MS : 1000));
          throw error;
        }
      }
    }
    if (!result) return null; // The watcher has not proven this span yet.
    const read = result, applied = await this.deps.uow.run(tx => this.deps.sources.apply(tx, current.revision, read, this.now()));
    if (applied.stream.state === 'gap' && applied.stream.lastIssue !== current.lastIssue)
      this.deps.log?.(`source ${key} in gap (${applied.stream.lastIssue}): read [${new Date(read.from).toISOString()}, ${new Date(read.to).toISOString()}] ${viaFast ? 'fast' : 'watched'}, ` +
        `fresh ${read.fresh}, complete ${read.complete}, ${read.completedAt - read.observedAt} ms`);
    return { fast: viaFast, fills: read.fills.length, kind: applied.kind, state: applied.stream.state, through: applied.stream.coverageThrough?.getTime() ?? null };
  }

  /** Enqueues each copy's new legs, then merges what waits together into
   * adjustments; returns the legs held back this pass. */
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
   * Same-coin legs of one copy that wait together become one follower
   * adjustment per run (copy-live-adjustments.ts): the newest leg's row
   * leads (its order carries the others, and its signal is the freshest),
   * the others are recorded merged into it. Ratio sizing only: a fixed
   * amount is spent once per trade. Returns the legs held back (an open too
   * small for the exchange).
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
    if (plan.expired.size) await this.deps.repository.refusePending([...plan.expired], 'merged_signal_expired');
    if (plan.refused.size) await this.deps.repository.refusePending([...plan.refused], 'below_min_notional');
    for (const run of plan.merges) {
      const lead = run.legs.at(-1)!, members = run.legs.slice(0, -1);
      await this.deps.repository.merge({ id: lead.id, mandateId: m.mandateId }, members.map(leg => leg.id));
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
    await this.deps.repository.record(insert);
  }

  async work(row: DispatchRow, m: LiveMandateWork | null, signalAgeMs: number): Promise<void> {
    const mandate = m ?? await this.mandateOf(row);
    if (!mandate) return;
    const key = `${this.deps.network}:${mandate.accountAddress}:${liveSourceExecutionCloid(row.mandateId, row.sourceFillId, row.leg)}`;
    if (row.state === 'pending') {
      // A journal under this identity means an earlier pass reached the
      // exchange boundary; only reconciliation may continue it.
      const journal = await this.deps.repository.journalState(key);
      if (journal !== null) { await this.deps.repository.update(row, { state: 'submitted', executionKey: key }); return; }
      return this.submit(row, mandate, signalAgeMs);
    }
    const state = row.executionKey ? await this.deps.repository.journalState(row.executionKey) : null;
    if (state === null) return;
    if (!TERMINAL_STATES.has(state)) { await this.execute(row, mandate); return; }
    const outcome = await this.deps.settler.settle({ userId: row.userId, accountId: row.accountId, accountAddress: mandate.accountAddress,
      sourceNetwork: mandate.sourceNetwork, leaderAddress: mandate.leaderAddress, key: row.executionKey! });
    if (outcome.kind === 'released') {
      await this.deps.repository.update(row, { state: 'settled', settledAt: new Date(this.now()), reason: null });
      try { await this.deps.settlementObservation?.(row.executionKey!); }
      catch { this.deps.log?.('Committed settlement observation could not be retained; scheduled reporting will retry'); }
    }
    else if (outcome.kind === 'unplaced') await this.deps.repository.update(row, { state: 'refused', reason: 'exchange_order_never_placed' });
    else if (outcome.kind === 'quarantine' || outcome.kind === 'unsent') await this.deps.repository.update(row, { state: 'refused', reason: outcome.reason.slice(0, 80) });
    else await this.deps.repository.update(row, { reason: outcome.reason.slice(0, 80) });
  }

  private async submit(row: DispatchRow, m: LiveMandateWork, signalAgeMs: number): Promise<void> {
    const now = this.now();
    // Only an open ages: a reduction or close is sent however late (CP-EXE-14-02).
    if (row.leg === 'open' && now - row.leaderTime.getTime() > signalAgeMs) {
      await this.deps.repository.update(row, { state: 'refused', reason: row.reason && row.attempts > 0 ? row.reason : 'signal_expired' }); return;
    }
    if (m.strategyStatus === 'stopping' || m.strategyStatus === 'stopped') {
      // The stop closes every position itself; no new leg of a stopping copy is sent.
      await this.deps.repository.update(row, { state: 'refused', reason: 'copy_stopping' }); return;
    }
    if (m.strategyStatus !== 'active') return; // paused: new legs wait, then expire.
    if (row.leg === 'close' && await this.deps.repository.closedByOwner(row.mandateId, row.accountId, row.coin)) {
      await this.deps.repository.update(row, { state: 'refused', reason: 'position_closed_by_owner' }); return;
    }
    if (row.leg === 'close' && !await this.deps.repository.everOpened(row.mandateId, row.coin)) {
      await this.deps.repository.update(row, { state: 'refused', reason: 'no_follower_position' }); return;
    }
    if (row.leg === 'open') {
      // A flip opens only after its close leg settled (the planner proves it).
      const close = await this.deps.repository.dispatch(`${row.mandateId}|${row.sourceFillId}|close`);
      if (close?.state === 'refused') { await this.deps.repository.update(row, { state: 'refused', reason: 'flip_close_not_settled' }); return; }
      if (close && close.state !== 'settled') return;
    }
    // In the leader's order: an earlier leg of the coin still waiting goes first.
    if (await this.deps.repository.earlierPending(row)) return;
    await this.execute(row, m, row.leg === 'open' ? row.leaderTime.getTime() + signalAgeMs : undefined);
  }

  /** Submits (first time) or reconciles (afterwards) the leg's one order. A
   * first submission's budget wait never outlasts the signal (`signalDeadline`). */
  private async execute(row: DispatchRow, m: LiveMandateWork, signalDeadline?: number): Promise<void> {
    const timing: { sentAt?: number; ackedAt?: number } = {}, first = row.firstAttemptAt ?? new Date(this.now());
    const runtime = this.deps.runtime({ onExchange: event => { if (event.phase === 'request') timing.sentAt ??= event.at; else timing.ackedAt ??= event.at; } });
    try {
      const members = row.adjustmentId === row.id ? await this.deps.repository.members(row.id) : [];
      const record = await runtime.execute({ userId: row.userId, accountId: row.accountId, mandateId: row.mandateId, sourceFillId: row.sourceFillId, leg: row.leg,
        ...(members.length ? { members } : {}), ...(signalDeadline !== undefined ? { signalDeadline } : {}) });
      const times = { ...(timing.sentAt ? { sentAt: new Date(timing.sentAt) } : {}), ...(timing.ackedAt ? { ackedAt: new Date(timing.ackedAt) } : {}) };
      if (record.errorCode === 'unattempted_expired' || record.errorCode === UNHELD_REJECTED) {
        const reason = record.errorCode === UNHELD_REJECTED ? (record.outcome?.reason ?? UNHELD_REJECTED).slice(0, 80) : 'unattempted_expired';
        await this.deps.repository.update(row, { state: 'refused', reason, executionKey: record.key, firstAttemptAt: first, attempts: row.attempts + 1 }); return;
      }
      await this.deps.repository.update(row, { state: 'submitted', executionKey: record.key, firstAttemptAt: first, attempts: row.attempts + 1, reason: null, ...times });
      if (row.state === 'pending') this.deps.trace?.(`Copy order ${row.id}${members.length ? ` (+${members.length} merged)` : ''}: received +${row.receivedAt.getTime() - row.leaderTime.getTime()}, ` +
        `first attempt +${first.getTime() - row.leaderTime.getTime()}, sent ${times.sentAt ? `+${times.sentAt.getTime() - row.leaderTime.getTime()}` : '-'} ms after the leader`);
    } catch (error) {
      const reason = reasonOf(error);
      if (error instanceof HyperliquidBudgetWait) this.deps.log?.(`leg ${row.id} budget unavailable: ${error.reason}, retry ${error.retryMs} ms`);
      // Stored as live_execution_failed: say what it really was (Stage 2026-10-06).
      const unexpected = describeUnexpected(error);
      if (unexpected) this.deps.log?.(`leg ${row.id} failed unexpectedly: ${unexpected}`);
      const times = timing.sentAt ? { sentAt: new Date(timing.sentAt), ...(timing.ackedAt ? { ackedAt: new Date(timing.ackedAt) } : {}) } : {};
      // A POST that began leaves an exchange-side outcome to reconcile.
      const key = `${this.deps.network}:${m.accountAddress}:${liveSourceExecutionCloid(row.mandateId, row.sourceFillId, row.leg)}`;
      const journal = await this.deps.repository.journalState(key);
      if (row.state === 'pending' && journal !== null && journal !== 'prepared') {
        await this.deps.repository.update(row, { state: 'submitted', executionKey: key, firstAttemptAt: first, attempts: row.attempts + 1, reason, ...times }); return;
      }
      // An open still below the exchange minimum (refused before any journal
      // claimed it) keeps waiting for more legs while its signal is young.
      const signalAgeMs = await this.deps.repository.signalAgeLimitMs();
      if (row.state === 'pending' && row.leg === 'open' && reason === 'below_min_notional' && journal === null &&
        this.now() - row.leaderTime.getTime() < Math.max(0, signalAgeMs - HOLD_MARGIN_MS)) {
        await this.deps.repository.dissolve(row, row.attempts + 1); return;
      }
      const permanent = row.state === 'pending' && (PERMANENT.has(reason) || row.leg === 'close' && (reason === 'no_follower_position' || row.attempts + 1 >= CLOSE_ATTEMPT_LIMIT));
      await this.deps.repository.update(row, { ...(permanent ? { state: 'refused' as const } : {}), reason, firstAttemptAt: first, attempts: row.attempts + 1, ...times });
    }
  }

  /**
   * The leader is flat on a coin (its latest fill closed it in full, no flip)
   * and the follower is not: its close leg was refused (never sent or not
   * sendable), or settled still owing part of the position (the reduction
   * carry an IOC close left unfilled). Requests a reduce-only close of what
   * the follower holds; the closer reads the account first and does nothing
   * if it is already flat.
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
      strategyStatus: await this.deps.repository.strategyStatus(mandate.strategyId) ?? 'stopped', activated: true, activatedAt: null };
  }
}
