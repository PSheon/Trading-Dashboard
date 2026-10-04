import type { HyperliquidLiveSourceClient } from '../copy-live-source.client.js';
import type { CopyLiveSourceRepository } from '../copy-live-source.repository.js';
import type { UnitOfWork } from '../../db/unit-of-work.js';
import type { LiveExecutionRecord } from '../live/live-execution.js';
import type { TestnetLiveExecutionHooks, TestnetLiveExecutionRequest } from '../live/testnet-live-execution-runtime.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill } from '../live/copy-live-source-evidence.js';
import { liveSourceExecutionCloid } from '../live/postgres-live-preparation.js';
import { LiveBoundaryError } from '../live/wallet-authorization.js';
import { TERMINAL_STATES, type LiveSettleOutcome, type LiveSettleRequest } from './copy-live-settler.js';
import type { CopyLiveWorkerRepository, DispatchRow, LiveMandateWork, LiveStreamWork } from './copy-live-worker.repository.js';
import type { WatchedMainnetSource } from './watched-mainnet-source.js';

export interface LiveExecutor { execute(request: TestnetLiveExecutionRequest): Promise<LiveExecutionRecord> }
export interface LiveEngineDependencies {
  readonly repository: CopyLiveWorkerRepository;
  readonly sources: CopyLiveSourceRepository;
  readonly uow: UnitOfWork;
  readonly watched: WatchedMainnetSource;
  /** Testnet leaders only (a testnet copy of a testnet address). */
  readonly testnetSource: HyperliquidLiveSourceClient;
  readonly runtime: (hooks: Pick<TestnetLiveExecutionHooks, 'onExchange'>) => LiveExecutor;
  readonly settler: { settle(request: LiveSettleRequest): Promise<LiveSettleOutcome> };
  /** Owner stop requests (cancel, close, flat, return); after the legs. */
  readonly stopper?: { tick(): Promise<void> };
  readonly log?: (message: string) => void;
}
export interface LiveEngineOptions {
  /** Testnet-leader REST polls are costly (two worst-case 120-weight reads):
   * at most one per stream this often. Mainnet leaders cost nothing extra. */
  readonly testnetSourceIntervalMs: number;
  /** A mainnet read stops this long before now, so the watcher can confirm. */
  readonly sourceLagMs: number;
  /** Work per pass stops once this much time has gone. */
  readonly passBudgetMs: number;
}
export const DEFAULT_ENGINE_OPTIONS: LiveEngineOptions = { testnetSourceIntervalMs: 60_000, sourceLagMs: 1_000, passBudgetMs: 20_000 };

/** Refusals that no retry can change. Everything else is retried until the
 * leader fill is older than the policy's signal age. */
const PERMANENT = new Set(['live_source_price_deviation', 'below_min_notional', 'live_risk_adoption_unproven', 'live_market_unknown',
  'live_account_unsupported_role', 'live_account_unsupported_abstraction', 'unattempted_expired']);
const reasonOf = (error: unknown) => {
  const code = error instanceof LiveBoundaryError ? error.code : error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message) ? error.message : 'live_execution_failed';
  return code.replace(/[^a-z0-9_]/g, '_').slice(0, 80);
};

/**
 * One pass of testnet copy execution, in this order: start funded
 * generations, ingest leader fills, enqueue new legs, then work the open
 * legs (submit pending ones, reconcile unknown/resting ones from the
 * exchange, settle terminal ones). Every step is restart-safe: the
 * executor's journal holds the order identity (cloid, nonce) and never
 * re-sends an attempted order; a restarted worker only reconciles it.
 */
export class CopyLiveEngine {
  private readonly lastTestnetRead = new Map<string, number>();
  constructor(private readonly deps: LiveEngineDependencies, private readonly options: LiveEngineOptions = DEFAULT_ENGINE_OPTIONS,
    private readonly now: () => number = Date.now) {}

  async tick(): Promise<void> {
    const started = this.now();
    let mandates = await this.deps.repository.mandates(started);
    if ((await this.deps.repository.activateFunded(mandates, started)).length) mandates = await this.deps.repository.mandates(this.now());
    for (const stream of this.deps.repository.streams(mandates)) {
      try { await this.ingest(stream, mandates); }
      catch (error) { this.deps.log?.(`source ${stream.network}:${stream.leaderAddress} not read: ${reasonOf(error)}`); }
    }
    const limit = await this.deps.repository.signalAgeLimitMs();
    for (const m of mandates.filter(row => row.activated && row.strategyStatus === 'active')) await this.enqueue(m);
    const byId = new Map(mandates.map(m => [m.mandateId, m]));
    for (const row of await this.deps.repository.open()) {
      if (this.now() - started > this.options.passBudgetMs) break;
      try { await this.work(row, byId.get(row.mandateId) ?? null, limit); }
      catch (error) { this.deps.log?.(`leg ${row.id} kept for the next pass: ${reasonOf(error)}`); }
    }
    if (this.deps.stopper) {
      try { await this.deps.stopper.tick(); }
      catch (error) { this.deps.log?.(`stops kept for the next pass: ${reasonOf(error)}`); }
    }
  }

  /** Extends one leader stream's proven coverage up to (almost) now. */
  async ingest(stream: LiveStreamWork, mandates: readonly LiveMandateWork[]): Promise<void> {
    const { network, leaderAddress } = stream, key = `${network}:${leaderAddress}`, now = this.now();
    if (network === 'testnet' && now - (this.lastTestnetRead.get(key) ?? 0) < this.options.testnetSourceIntervalMs) return;
    let current = await this.deps.uow.run(tx => this.deps.sources.ensure(tx, leaderAddress, network));
    if (current.state === 'quarantined') return;
    const earliest = mandates.filter(m => m.sourceNetwork === network && m.leaderAddress === leaderAddress).reduce((min, m) => Math.min(min, m.cursor.getTime()), Infinity);
    // A span that no current generation needs (it ended before every active
    // cursor) restarts at the earliest cursor instead of reading the gap.
    if (current.coverageThrough && current.coverageThrough.getTime() < earliest - 1) {
      const restarted = await this.deps.uow.run(tx => this.deps.sources.restart(tx, leaderAddress, network, current.revision, now));
      if (restarted.kind !== 'recorded') return;
      current = restarted.stream;
    }
    const from = current.coverageThrough ? current.coverageThrough.getTime() + 1 : earliest;
    const to = Math.min(now - this.options.sourceLagMs, from + 10 * 60_000);
    if (!Number.isFinite(from) || to < from) return;
    if (network === 'testnet') this.lastTestnetRead.set(key, now);
    const result = network === 'mainnet' ? await this.deps.watched.read(leaderAddress, from, to)
      : await this.deps.testnetSource.read({ leaderAddress, from, to, maxRequests: 8 });
    if (!result) return; // The watcher has not proven this span yet.
    await this.deps.uow.run(tx => this.deps.sources.apply(tx, current.revision, result, this.now()));
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
      return legs.map(leg => ({ ...base, id: `${m.mandateId}|${row.id}|${leg.leg}`, leg: leg.leg }));
    });
    await this.deps.repository.record(insert);
  }

  async work(row: DispatchRow, m: LiveMandateWork | null, signalAgeMs: number): Promise<void> {
    const mandate = m ?? await this.mandateOf(row);
    if (!mandate) return;
    const key = `testnet:${mandate.accountAddress}:${liveSourceExecutionCloid(row.mandateId, row.sourceFillId, row.leg)}`;
    if (row.state === 'pending') {
      // A journal under this identity means an earlier pass reached the
      // exchange boundary; only reconciliation may continue it.
      const journal = await this.deps.repository.journalState(key);
      if (journal !== null) { await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'submitted', executionKey: key }); return; }
      return this.submit(row, mandate, signalAgeMs);
    }
    const state = row.executionKey ? await this.deps.repository.journalState(row.executionKey) : null;
    if (state === null) return;
    if (!TERMINAL_STATES.has(state)) { await this.execute(row, mandate); return; }
    const outcome = await this.deps.settler.settle({ userId: row.userId, accountId: row.accountId, accountAddress: mandate.accountAddress,
      sourceNetwork: mandate.sourceNetwork, leaderAddress: mandate.leaderAddress, key: row.executionKey! });
    if (outcome.kind === 'released') await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'settled', settledAt: new Date(this.now()), reason: null });
    else if (outcome.kind === 'unplaced') await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'refused', reason: 'exchange_order_never_placed' });
    else if (outcome.kind === 'quarantine') await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'refused', reason: outcome.reason.slice(0, 80) });
    else await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { reason: outcome.reason.slice(0, 80) });
  }

  private async submit(row: DispatchRow, m: LiveMandateWork, signalAgeMs: number): Promise<void> {
    const now = this.now();
    if (now - row.leaderTime.getTime() > signalAgeMs) {
      await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'refused', reason: row.reason && row.attempts > 0 ? row.reason : 'signal_expired' }); return;
    }
    if (m.strategyStatus === 'stopping' || m.strategyStatus === 'stopped') {
      // The stop closes every position itself; no new leg of a stopping copy is sent.
      await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'refused', reason: 'copy_stopping' }); return;
    }
    if (m.strategyStatus !== 'active') return; // paused: new legs wait, then expire.
    if (row.leg === 'close' && !await this.deps.repository.everOpened(row.mandateId, row.coin)) {
      await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'refused', reason: 'no_follower_position' }); return;
    }
    if (row.leg === 'open') {
      // A flip opens only after its close leg settled (the planner proves it).
      const close = await this.deps.repository.dispatch(`${row.mandateId}|${row.sourceFillId}|close`);
      if (close?.state === 'refused') { await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'refused', reason: 'flip_close_not_settled' }); return; }
      if (close && close.state !== 'settled') return;
    }
    await this.execute(row, m);
  }

  /** Submits (first time) or reconciles (afterwards) the leg's one order. */
  private async execute(row: DispatchRow, m: LiveMandateWork): Promise<void> {
    const timing: { sentAt?: number; ackedAt?: number } = {}, first = row.firstAttemptAt ?? new Date(this.now());
    const runtime = this.deps.runtime({ onExchange: event => { if (event.phase === 'request') timing.sentAt ??= event.at; else timing.ackedAt ??= event.at; } });
    try {
      const record = await runtime.execute({ userId: row.userId, accountId: row.accountId, mandateId: row.mandateId, sourceFillId: row.sourceFillId, leg: row.leg });
      const times = { ...(timing.sentAt ? { sentAt: new Date(timing.sentAt) } : {}), ...(timing.ackedAt ? { ackedAt: new Date(timing.ackedAt) } : {}) };
      if (record.errorCode === 'unattempted_expired') {
        await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'refused', reason: 'unattempted_expired', executionKey: record.key, firstAttemptAt: first, attempts: row.attempts + 1 }); return;
      }
      await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'submitted', executionKey: record.key, firstAttemptAt: first, attempts: row.attempts + 1, reason: null, ...times });
    } catch (error) {
      const reason = reasonOf(error);
      const times = timing.sentAt ? { sentAt: new Date(timing.sentAt), ...(timing.ackedAt ? { ackedAt: new Date(timing.ackedAt) } : {}) } : {};
      // A POST that began leaves an exchange-side outcome to reconcile.
      const key = `testnet:${m.accountAddress}:${liveSourceExecutionCloid(row.mandateId, row.sourceFillId, row.leg)}`;
      const journal = await this.deps.repository.journalState(key);
      if (row.state === 'pending' && journal !== null && journal !== 'prepared') {
        await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { state: 'submitted', executionKey: key, firstAttemptAt: first, attempts: row.attempts + 1, reason, ...times }); return;
      }
      const permanent = row.state === 'pending' && PERMANENT.has(reason);
      await this.deps.repository.update(row.id, row.state as 'pending' | 'submitted', { ...(permanent ? { state: 'refused' as const } : {}), reason, firstAttemptAt: first, attempts: row.attempts + 1, ...times });
    }
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
