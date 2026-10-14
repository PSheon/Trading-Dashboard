import { and, eq, sql } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type { SettlementClaim } from './copy-live-settlement-claim.js';
import { settlementFencedPool } from './copy-live-settlement-fenced-pool.js';
import { Pool } from 'pg';
import { WALLET_NETWORKS, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { copyLiveExecutions, copyLiveRiskReservations, copyLiveExecutionEvidence, copyFollowerReceipts, copyFollowerScans } from '@trading-dashboard/shared/database';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { RequestBudgeterService } from '../../hyperliquid/request-budgeter.service.js';
import { reserveLive } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { isDefinitelyUnsent, NEVER_PLACED, UNHELD_REJECTED, type LiveExecutionRecord } from '../live/live-execution.js';
import { HyperliquidLiveAccountObserver, observerRestWeight } from '../live/live-account-observer.js';
import { HyperliquidAllDexsAccountSource, PerReadAllDexsAccountSource } from '../live/live-account-ws-source.js';
import { boundedLiveRead, HyperliquidLiveMarketResolver } from '../live/live-market-resolver.js';
import { parseLiveOrderEvidence, type LiveOrderEvidence } from '../live/live-order-evidence.js';
import { decodeLiveExecutionRow } from '../live/postgres-live-journal.js';
import { PostgresLiveRiskScope } from '../live/postgres-live-risk-scope.js';
import { PostgresLiveSettlement } from '../live/postgres-live-settlement.js';
import { LiveBoundaryError } from '../live/wallet-authorization.js';
import { LiveSharedReads } from '../live/live-shared-reads.js';
import type { LiveSourceNetwork } from '../live/copy-live-source-evidence.js';
import { liveReadCache } from '../live/live-read-cache.js';
import { LIVE_EVIDENCE_MAX_AGE_MS, LIVE_FILL_SCAN_MARGIN_MS, NEVER_PLACED_GRACE_MS, PROVIDER_CLOCK_SKEW_MS, SETTLEMENT_CLAIM_WAIT_MS } from '../../config/constants/timings.js';
import { sharedRestRetryAfterMs } from '../../hyperliquid/hyperliquid-capacity-error.js';
import { RESPONSE_WEIGHT } from '../live/follower-receipt-reader.js';
import { errorCode } from '../../runtime/safe-error-text.js';

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['filled', 'partial', 'cancelled', 'rejected']);
export interface LiveSettleRequest {
  readonly userId: number; readonly accountId: string; readonly accountAddress: string;
  readonly sourceNetwork: LiveSourceNetwork; readonly leaderAddress: string; readonly key: string;
}
/** `unsent`: a journal rejected before its hold committed (never signed or
 * sent, no reservation): nothing to settle; `reason` is its refusal.
 * `unplaced`: a never-placed order's liability released; `unsent` when its
 * request provably never began (released at once, its leg may be planned again). */
export type LiveSettleOutcome = { kind: 'released' } | { kind: 'unplaced'; unsent?: true } |{ kind: 'pending' | 'quarantine' | 'unsent'; reason: string };

/**
 * Settles one terminal order on the deployment's network (`network`): scans the account's own fills now
 * (so settlement need not wait for the scheduled follower scan), reads
 * the order's status as settlement evidence, observes the account, and asks
 * Codex's settlement DAL to release the reservation and settle the leg
 * (which a flip's opening leg waits for). Read-only at the exchange.
 */
export class CopyLiveSettler {
  constructor(readonly network: HyperliquidNetwork, private readonly pool: Pool, private readonly global: HyperliquidGlobalTransport, private readonly budget: RequestBudgeterService,
    private readonly scanner: { runFor(accountId: string): Promise<void> }, private readonly now = Date.now) {}

  async settle(request: LiveSettleRequest, claim?: SettlementClaim): Promise<LiveSettleOutcome> {
    if (claim) await claim.assertHeld();
    const fetchInfo: typeof fetch = claim ? async (input, init) => {
      await claim.assertHeld();
      const response = await this.global.fetchInfo(input, { ...init, signal: init?.signal ? AbortSignal.any([claim.signal, init.signal]) : claim.signal });
      await claim.assertHeld();
      return response;
    } : this.global.fetchInfo;
    const record = await this.record(request.key, claim);
    if (!record || !TERMINAL_STATES.has(record.state)) return { kind: 'pending', reason: 'live_settlement_not_terminal' };
    // An order of another network (a database that moved networks) is history:
    // never read or settled here.
    if (record.authorization.network !== this.network) return { kind: 'pending', reason: 'live_other_network' };
    if (record.errorCode === UNHELD_REJECTED) return { kind: 'unsent', reason: record.outcome?.reason ?? UNHELD_REJECTED };
    // Its request never began (the journal's durable unsent marker): nothing
    // is in flight, so no grace and no provider read. Released at once under
    // the original locks, which re-check the marker and that no oid, receipt
    // or exchange evidence exists (releaseUnsent).
    if (isDefinitelyUnsent(record)) {
      const released = await new PostgresLiveRiskScope(this.pool, this.now, claim, { kind: 'settlement_release_unsent', id: request.key }).run({ userId: request.userId, network: this.network, accountAddress: request.accountAddress,
        source: { network: request.sourceNetwork, leaderAddress: request.leaderAddress } }, async (_scope, session) =>
        new PostgresLiveSettlement(this.now).releaseUnsent(session, { accountId: request.accountId, key: request.key }));
      return released.kind === 'released' ? { kind: 'unplaced', unsent: true } : released;
    }
    // This is a routing wait, never missing-order or release evidence. Before
    // the unchanged signed expiry plus grace, releaseNeverPlaced cannot pass.
    // Skip provider/quota/scanner work only when current local SQL has no
    // positive fill/order evidence; all later proof/CAS paths remain intact.
    const waitStarted=this.now(),deadline=record.expiresAfter+NEVER_PLACED_GRACE_MS;
    const mayWait=(at:number)=>record.state==='rejected'&&record.errorCode===NEVER_PLACED&&
      (record.outcome?.filledSize===undefined||record.outcome.filledSize==='0')&&record.outcome?.exchangeOrderId===undefined&&
      Number.isSafeInteger(at)&&Number.isSafeInteger(deadline)&&at>=record.createdAt&&at>=record.updatedAt&&at<=deadline;
    if(mayWait(waitStarted)) {
      const [local]=await drizzle(claim?settlementFencedPool(this.pool,claim):this.pool).select({
        hasReceipt:sql<boolean>`exists(select 1 from ${copyFollowerReceipts} where ${copyFollowerReceipts.executionKey}=${request.key})`,
        hasReservationOid:sql<boolean>`exists(select 1 from ${copyLiveRiskReservations} where ${copyLiveRiskReservations.key}=${request.key} and ${copyLiveRiskReservations.exchangeOrderId} is not null)`,
        hasEvidenceOid:sql<boolean>`exists(select 1 from ${copyLiveExecutionEvidence} where ${copyLiveExecutionEvidence.key}=${request.key} and ${copyLiveExecutionEvidence.exchangeOrderId} is not null)`,
      }).from(copyLiveExecutions).where(and(eq(copyLiveExecutions.key,request.key),eq(copyLiveExecutions.state,'rejected'),
        eq(copyLiveExecutions.updatedAt,new Date(record.updatedAt)),sql`${copyLiveExecutions.record}->>'errorCode'=${NEVER_PLACED}`,
        sql`${copyLiveExecutions.record}=${JSON.stringify(record)}::jsonb`));
      if(claim)await claim.assertHeld();
      const checkedNow=this.now();
      if(checkedNow>=waitStarted&&mayWait(checkedNow)&&local?.hasReceipt===false&&local.hasReservationOid===false&&local.hasEvidenceOid===false)
        return {kind:'pending',reason:'live_settlement_never_placed_grace'};
    }
    // A crash can leave the dispatch submitted after the release committed.
    // This SQL hint only chooses a path: the original locked DAL must replay
    // every certificate, journal, source and receipt proof before completion.
    if (this.network === 'testnet') {
      const [hint] = await drizzle(claim ? settlementFencedPool(this.pool, claim) : this.pool).select({ state: copyLiveRiskReservations.state, revision: copyLiveRiskReservations.revision,
        releaseReason: copyLiveRiskReservations.releaseReason }).from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key, request.key));
      if (hint?.state === 'released' && hint.releaseReason === 'verified_settlement') {
        const scope = new PostgresLiveRiskScope(this.pool, this.now, claim, { kind: 'settlement_replay', id: request.key });
        return scope.run({ userId: request.userId, network: this.network, accountAddress: request.accountAddress,
          source: { network: request.sourceNetwork, leaderAddress: request.leaderAddress } }, async (_scope, session) => {
          const decision = await new PostgresLiveSettlement(this.now).replaySettlement(session, { accountId: request.accountId, key: request.key,
            expectedReservationRevision: hint.revision });
          return decision.kind === 'release' ? { kind: 'released' as const } : decision;
        });
      }
    }
    // A retry never repeats a scan whose work is already durable: once the
    // account's fill-scan cursor is past this order (scanCovered), every fill
    // of it is booked, and the settlement DAL reads those receipts and that
    // cursor itself, in its own session, exactly as after a fresh scan.
    const scan = !!record.outcome?.filledSize && record.outcome.filledSize !== '0' && !await this.scanCovered(request.accountId, record, claim);
    // Routing/journal data only estimates the cost, never grants settlement
    // authority. Pay for market identity, orderStatus and the complete account
    // observation BEFORE taking the original locks. That scope revalidates the
    // journal and every release proof; all provider/SQL clocks stay at 5 s.
    let prepaid = (record.action.orders[0]!.a < 10_000 ? 20 : 40) + 2 + (record.errorCode === NEVER_PLACED ? 0 : observerRestWeight(request.accountAddress, liveReadCache(this.network)));
    // A terminal order's settlement is live work (the copy's next order waits
    // for it): its whole need (the fill scan's two list reads and the
    // evidence above) is announced on the shared meter as an order's is
    // (claimLive), so background, setups and pages leave it free and the room
    // that frees up is its first. Its reads run under that token (runLive).
    // Scheduling only: every proof, lock and CAS below is unchanged.
    const token = await this.claimLive((scan ? 2 * RESPONSE_WEIGHT : 0) + prepaid);
    if (claim) await claim.assertHeld();
    const lane = <T>(work: () => Promise<T>) => token === undefined ? work() : this.global.runLive(token, work);
    return lane(async () => {
    // Book the account's own fills now (the scheduled scan reaches an account
    // only every two minutes). The scan also advances its proven horizon,
    // which the next order's position projection requires.
    if (scan) {
      if (claim) await claim.assertHeld();
      await this.scanner.runFor(request.accountId);
      if (claim) await claim.assertHeld();
    }
    await reserveLive(this.budget, prepaid, { maxWaitMs: Math.min(180_000, this.budget.refillMs()), ...(claim ? { signal: claim.signal } : {}) });
    const acquire = async (weight: number) => {
      claim?.assertFresh();
      const credit = Math.min(prepaid, weight); prepaid -= credit;
      try { if (weight > credit) await reserveLive(this.budget, weight - credit, { maxWaitMs: 5000, ...(claim ? { signal: claim.signal } : {}) }); }
      catch (error) { prepaid += credit; throw error; }
    };
    const scope = new PostgresLiveRiskScope(this.pool, this.now, claim, { kind: 'settlement', id: request.key });
    try { return await scope.run({ userId: request.userId, network: this.network, accountAddress: request.accountAddress,
      source: { network: request.sourceNetwork, leaderAddress: request.leaderAddress } }, async (_scope, session) => this.global.runOriginal(session, async () => {
      this.global.currentQuota();
      const sockets = new PerReadAllDexsAccountSource(() => new HyperliquidAllDexsAccountSource(this.now, undefined, this.network, this.global), 2);
      try {
        const resolver = new HyperliquidLiveMarketResolver(this.network, acquire, fetchInfo, this.now);
        const settlement = new PostgresLiveSettlement(this.now);
        const evidence = await this.orderEvidence(record, resolver, acquire, fetchInfo, claim);
        const observed = await settlement.observe(session, { accountId: request.accountId, key: request.key, evidence });
        if (observed.kind !== 'recorded') return observed;
        // Never placed (expired unknown by cloid): release, nothing to settle.
        if (record.errorCode === NEVER_PLACED) {
          const released = await settlement.releaseNeverPlaced(session, { accountId: request.accountId, key: request.key });
          return released.kind === 'released' ? { kind: 'unplaced' as const } : released;
        }
        const observer = new HyperliquidLiveAccountObserver(this.network, acquire, fetchInfo, this.now, 5000, sockets, undefined, liveReadCache(this.network));
        const snapshot = await observer.observe(request.accountAddress);
        const [reservation] = await session.read(db => db.select({ revision: copyLiveRiskReservations.revision, accountId: copyLiveRiskReservations.accountId,
          strategyId: copyLiveRiskReservations.strategyId }).from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key, request.key)));
        if (!reservation) return { kind: 'pending' as const, reason: 'live_settlement_reservation_missing' };
        const decision = await settlement.settle(session, { accountId: request.accountId, key: request.key, expectedReservationRevision: reservation.revision,
          accountSource: { accountId: request.accountId, userId: request.userId, strategyId: reservation.strategyId, network: this.network, accountAddress: request.accountAddress,
            checkedAt: snapshot.completedAt, sourceDigest: snapshot.sourceDigest, quarantined: false, snapshot } });
        return decision.kind === 'release' ? { kind: 'released' as const } : decision;
      } finally { await sockets.close(); }
    })); } finally { if (prepaid > 0) this.budget.adjust(-prepaid); }
    });
  }

  /** Settlement's need on the shared meter (HyperliquidGlobalTransport.claimLive),
   * waited for at most a charge's lifetime: its token, or undefined when the
   * meter records no demand (the settlement runs as before). A wait longer
   * than that is the meter's capacity error (the loop retries). */
  private async claimLive(weight: number): Promise<string | undefined> {
    try { return await this.global.claimLive(weight, this.now() + SETTLEMENT_CLAIM_WAIT_MS); }
    catch (error) {
      if (sharedRestRetryAfterMs(error) !== undefined) throw error;
      new Logger('CopyLiveSettler').warn(`settlement live demand not claimed: ${errorCode(error, 'unknown')}`);
      return undefined;
    }
  }

  /**
   * Whether the account's fill-scan cursor (copy_follower_scans.through:
   * advanced only by a scan that booked every fill to it; not while the scan
   * carries an issue, as the settlement DAL reads it) is already past this
   * order: its terminal journal write (our clock, after the exchange's
   * terminal stamp, which may run PROVIDER_CLOCK_SKEW_MS ahead of ours) plus
   * LIVE_FILL_SCAN_MARGIN_MS, the margin the DAL itself requires past the
   * cancel. A scan now would book nothing more of this order. Path choice
   * only: the DAL still proves the receipts' total and the cursor.
   */
  private async scanCovered(accountId: string, record: LiveExecutionRecord, claim?: SettlementClaim): Promise<boolean> {
    const [row] = await drizzle(claim ? settlementFencedPool(this.pool, claim) : this.pool).select({ through: copyFollowerScans.through, issue: copyFollowerScans.issue })
      .from(copyFollowerScans).where(eq(copyFollowerScans.accountId, accountId));
    if (claim) await claim.assertHeld();
    return !!row && row.issue === null && row.through !== null && Number.isSafeInteger(record.updatedAt) &&
      row.through >= record.updatedAt + PROVIDER_CLOCK_SKEW_MS + LIVE_FILL_SCAN_MARGIN_MS;
  }

  private async record(key: string, claim?: SettlementClaim): Promise<LiveExecutionRecord | null> {
    const [row] = await drizzle(claim ? settlementFencedPool(this.pool, claim) : this.pool).select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
    return row ? decodeLiveExecutionRow(row) : null;
  }

  /** Settlement-grade orderStatus by the original cloid (as the transport's
   * queryEvidence), through the shared egress quota. */
  private async orderEvidence(record: LiveExecutionRecord, resolver: HyperliquidLiveMarketResolver, acquire: (weight: number) => Promise<void>, fetchInfo: typeof fetch, claim?: SettlementClaim): Promise<LiveOrderEvidence> {
    // Default-dex metadata and cloid status are independent provider reads.
    // One original-scope quota charge sends them together; SQL retention and
    // the later account proof remain sequential. Named dex resolution keeps
    // its required index lookup path.
    if (record.action.orders[0]!.a < 10_000) {
      const status = { type: 'orderStatus', user: record.authorization.accountAddress, oid: record.action.orders[0]!.c };
      const shared = new LiveSharedReads(this.network, fetchInfo, (bodies, onDispatch, signal) =>
        this.global.fetchInfoBatch(WALLET_NETWORKS[this.network].infoUrl, bodies, {
          maxWaitMs: 0, signal: claim ? AbortSignal.any([claim.signal, signal]) : signal,
          onDispatch: () => { claim?.assertFresh(); onDispatch(); return signal; },
        }), this.now, 5000, acquire);
      try {
        await shared.pay(22);
        await shared.wave([{ type: 'meta' }, status]);
        const market = await resolver.resolveAsset(record.action.orders[0]!.a, shared);
        const raw = await shared.get(status), completedAt = this.now();
        return parseLiveOrderEvidence({ record, market, raw, checkedAt: shared.startedAt, completedAt, now: completedAt });
      } finally {
        // Only weight never dispatched is returned; rejected provider replies
        // still consumed their original shared and local quota.
        if (shared.paidWeight > shared.sentWeight) this.budget.adjust(-(shared.paidWeight - shared.sentWeight));
      }
    }
    const checkedAt = this.now(), remaining = () => {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now - checkedAt > LIVE_EVIDENCE_MAX_AGE_MS) throw new LiveBoundaryError('live_boundary_evidence_expired');
      return Math.max(1, 5000 - (now - checkedAt));
    };
    const market = await boundedLiveRead(() => resolver.resolveAsset(record.action.orders[0]!.a), remaining());
    // orderStatus weighs 2 (Hyperliquid's light reads; the shared meter's table).
    await boundedLiveRead(() => acquire(2), remaining());
    const response = await boundedLiveRead(() => fetchInfo(WALLET_NETWORKS[this.network].infoUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'orderStatus', user: record.authorization.accountAddress, oid: record.action.orders[0]!.c }),
      signal: claim ? AbortSignal.any([claim.signal, AbortSignal.timeout(remaining())]) : AbortSignal.timeout(remaining()), redirect: 'error' }), remaining());
    if (!response.ok) throw new LiveBoundaryError('exchange_http_failure');
    const raw = await boundedLiveRead(() => readInfoJson(response, 'live order evidence', 256 * 1024), remaining());
    const completedAt = this.now();
    return parseLiveOrderEvidence({ record, market, raw, checkedAt, completedAt, now: completedAt });
  }
}
