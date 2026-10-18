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
import { NEVER_PLACED_GRACE_MS, PROVIDER_CLOCK_SKEW_MS, SETTLEMENT_CLAIM_WAIT_MS } from '../../config/constants/timings.js';
import { sharedRestRetryAfterMs } from '../../hyperliquid/hyperliquid-capacity-error.js';
import { RESPONSE_WEIGHT } from '../live/follower-receipt-reader.js';
import { errorCode } from '../../runtime/safe-error-text.js';
import { liveEvidenceMaxAgeMs, liveFillScanMarginMs } from '../../config/live-evidence-window.js';

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['filled', 'partial', 'cancelled', 'rejected']);
export interface LiveSettleRequest {
  readonly userId: number; readonly accountId: string; readonly accountAddress: string;
  readonly sourceNetwork: LiveSourceNetwork; readonly leaderAddress: string; readonly key: string;
}
/** `unsent`: rejected before its hold committed (never sent, no reservation); nothing to settle.
 * `unplaced`: a never-placed order's liability released; `unsent: true` when its
 * request provably never began (its leg may be planned again). */
export type LiveSettleOutcome = { kind: 'released' } | { kind: 'unplaced'; unsent?: true } |{ kind: 'pending' | 'quarantine' | 'unsent'; reason: string };
/** CopyLiveSettler.quarantine's answer: the order quarantined (with the account's flat stop, if any), or already released. */
export type LiveQuarantineOutcome = Readonly<{ kind: 'released' } | { kind: 'quarantine'; reason: string; flat: { stopId: string; flatDigest: string; flatVerifiedAt: number } | null }>;

/**
 * Settles one terminal order on `network`: scans the account's fills now, reads
 * orderStatus as evidence, observes the account, and has the settlement DAL
 * release the reservation and settle the leg. Read-only at the exchange.
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
    // Another network's order is history: never read or settled here.
    if (record.authorization.network !== this.network) return { kind: 'pending', reason: 'live_other_network' };
    if (record.errorCode === UNHELD_REJECTED) return { kind: 'unsent', reason: record.outcome?.reason ?? UNHELD_REJECTED };
    // Durable unsent marker: no grace, no provider read; releaseUnsent re-checks
    // the marker and that no oid, receipt or exchange evidence exists.
    if (isDefinitelyUnsent(record)) {
      const released = await new PostgresLiveRiskScope(this.pool, this.now, claim, { kind: 'settlement_release_unsent', id: request.key }).run({ userId: request.userId, network: this.network, accountAddress: request.accountAddress,
        source: { network: request.sourceNetwork, leaderAddress: request.leaderAddress } }, async (_scope, session) =>
        new PostgresLiveSettlement(this.now).releaseUnsent(session, { accountId: request.accountId, key: request.key }));
      return released.kind === 'released' ? { kind: 'unplaced', unsent: true } : released;
    }
    // Routing only, not evidence: before expiry + grace releaseNeverPlaced cannot
    // pass, so skip provider work while local SQL shows no fill/order evidence.
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
    // A crash can leave the dispatch submitted after the release committed. This
    // hint only picks the path: the locked DAL replays every proof.
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
    // Skip the scan once the fill-scan cursor is past this order (scanCovered).
    const scan = !!record.outcome?.filledSize && record.outcome.filledSize !== '0' && !await this.scanCovered(request.accountId, record, claim);
    // Prepay the reads (market, orderStatus, account observation) before taking
    // the locks; the estimate grants no authority (the scope revalidates all).
    let prepaid = (record.action.orders[0]!.a < 10_000 ? 20 : 40) + 2 + (record.errorCode === NEVER_PLACED ? 0 : observerRestWeight(request.accountAddress, liveReadCache(this.network)));
    // Settlement is live work (the next order waits for it): its whole need is
    // claimed on the shared meter (claimLive) and its reads run under that token.
    // The claim is keyed by the order: a pass that gives up waiting keeps its
    // place, and the next pass renews that claim instead of queueing behind it.
    const token = await this.claimLive((scan ? 2 * RESPONSE_WEIGHT : 0) + prepaid, request.key);
    if (claim) await claim.assertHeld();
    // Its charges are the live lane's under that token, named the settlement's (`live:<token>:settle:`).
    const lane = <T>(work: () => Promise<T>) => this.global.runOwned('settle', () => token === undefined ? work() : this.global.runLive(token, work));
    // The pass's reads are over (sent or refused): its claim keeps nothing free.
    try { return await lane(async () => {
    // Book fills now (the scheduled scan is slow); it also advances the proven
    // horizon the next order's position projection needs.
    if (scan) {
      if (claim) await claim.assertHeld();
      // A fill of another order still in flight holds the scan back (follower_attribution_pending):
      // a wait, not a failed pass; this order's receipts, if not yet booked, keep it pending.
      try { await this.scanner.runFor(request.accountId); }
      catch (error) { if (!(error instanceof LiveBoundaryError && error.code === 'follower_attribution_pending')) throw error; }
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
        const observer = new HyperliquidLiveAccountObserver(this.network, acquire, fetchInfo, this.now, liveEvidenceMaxAgeMs(this.network), sockets, undefined, liveReadCache(this.network));
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
    }); } finally { if (token !== undefined) await this.global.releaseLive(request.key); }
  }

  /**
   * Gives a settlement that could not prove its order (SETTLEMENT_RETRY_POLICY
   * exhausted) to its owner: its reservation is quarantined (the account too),
   * so nothing retries it or claims live demand for it again. No provider read.
   * `flat`: the account's stop proven flat after the order, for the ALERT.
   */
  async quarantine(request: LiveSettleRequest, reason: string, claim?: SettlementClaim): Promise<LiveQuarantineOutcome> {
    if (claim) await claim.assertHeld();
    return new PostgresLiveRiskScope(this.pool, this.now, claim, { kind: 'settlement_quarantine', id: request.key }).run({ userId: request.userId, network: this.network,
      accountAddress: request.accountAddress, source: { network: request.sourceNetwork, leaderAddress: request.leaderAddress } }, async (_scope, session) =>
      new PostgresLiveSettlement(this.now).quarantineUnsettled(session, { accountId: request.accountId, key: request.key, reason }));
  }

  /** Claims settlement's need on the shared meter (claimLive, keyed by the
   * order `key`): its token, or undefined if the claim fails unexpectedly; a
   * capacity error is rethrown (the loop retries; the claim keeps its place). */
  private async claimLive(weight: number, key: string): Promise<string | undefined> {
    try { return await this.global.claimLive(weight, this.now() + SETTLEMENT_CLAIM_WAIT_MS, key); }
    catch (error) {
      const quoted = sharedRestRetryAfterMs(error);
      // Says why the pass stops (the loop's line only has the error code).
      if (quoted !== undefined) { new Logger('CopyLiveSettler').log(`settlement ${key} waits for live room: need ${Math.ceil(weight)}, quoted ${quoted} ms (its claim keeps its place)`); throw error; }
      new Logger('CopyLiveSettler').warn(`settlement live demand not claimed: ${errorCode(error, 'unknown')}`);
      return undefined;
    }
  }

  /**
   * Whether the issue-free fill-scan cursor is past this order's terminal write
   * plus PROVIDER_CLOCK_SKEW_MS + liveFillScanMarginMs() (the DAL's own
   * margin), so a scan would book nothing more. Path choice only; the DAL still proves.
   */
  private async scanCovered(accountId: string, record: LiveExecutionRecord, claim?: SettlementClaim): Promise<boolean> {
    const [row] = await drizzle(claim ? settlementFencedPool(this.pool, claim) : this.pool).select({ through: copyFollowerScans.through, issue: copyFollowerScans.issue })
      .from(copyFollowerScans).where(eq(copyFollowerScans.accountId, accountId));
    if (claim) await claim.assertHeld();
    return !!row && row.issue === null && row.through !== null && Number.isSafeInteger(record.updatedAt) &&
      row.through >= record.updatedAt + PROVIDER_CLOCK_SKEW_MS + liveFillScanMarginMs(this.network);
  }

  private async record(key: string, claim?: SettlementClaim): Promise<LiveExecutionRecord | null> {
    const [row] = await drizzle(claim ? settlementFencedPool(this.pool, claim) : this.pool).select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
    return row ? decodeLiveExecutionRow(row) : null;
  }

  /** Settlement-grade orderStatus by the original cloid, via the shared quota. */
  private async orderEvidence(record: LiveExecutionRecord, resolver: HyperliquidLiveMarketResolver, acquire: (weight: number) => Promise<void>, fetchInfo: typeof fetch, claim?: SettlementClaim): Promise<LiveOrderEvidence> {
    // Default dex: meta and orderStatus go together under one charge. Named dexes take the lookup path below.
    if (record.action.orders[0]!.a < 10_000) {
      const status = { type: 'orderStatus', user: record.authorization.accountAddress, oid: record.action.orders[0]!.c };
      const shared = new LiveSharedReads(this.network, fetchInfo, (bodies, onDispatch, signal) =>
        this.global.fetchInfoBatch(WALLET_NETWORKS[this.network].infoUrl, bodies, {
          maxWaitMs: 0, signal: claim ? AbortSignal.any([claim.signal, signal]) : signal,
          onDispatch: () => { claim?.assertFresh(); onDispatch(); return signal; },
        }), this.now, liveEvidenceMaxAgeMs(this.network), acquire);
      try {
        await shared.pay(22);
        await shared.wave([{ type: 'meta' }, status]);
        const market = await resolver.resolveAsset(record.action.orders[0]!.a, shared);
        const raw = await shared.get(status), completedAt = this.now();
        return parseLiveOrderEvidence({ record, market, raw, checkedAt: shared.startedAt, completedAt, now: completedAt });
      } finally {
        // Refund only undispatched weight (rejected replies still consumed quota).
        if (shared.paidWeight > shared.sentWeight) this.budget.adjust(-(shared.paidWeight - shared.sentWeight));
      }
    }
    const checkedAt = this.now(), remaining = () => {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now - checkedAt > liveEvidenceMaxAgeMs(this.network)) throw new LiveBoundaryError('live_boundary_evidence_expired');
      return Math.max(1, liveEvidenceMaxAgeMs(this.network) - (now - checkedAt));
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
