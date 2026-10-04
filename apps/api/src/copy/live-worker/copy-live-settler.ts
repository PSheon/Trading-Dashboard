import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { copyLiveExecutions, copyLiveRiskReservations } from '@trading-dashboard/shared/database';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { RequestBudgeterService } from '../../hyperliquid/request-budgeter.service.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { NEVER_PLACED, type LiveExecutionRecord } from '../live/live-execution.js';
import { HyperliquidLiveAccountObserver } from '../live/live-account-observer.js';
import { HyperliquidAllDexsAccountSource } from '../live/live-account-ws-source.js';
import { boundedLiveRead, HyperliquidLiveMarketResolver } from '../live/live-market-resolver.js';
import { parseLiveOrderEvidence, type LiveOrderEvidence } from '../live/live-order-evidence.js';
import { decodeLiveExecutionRow } from '../live/postgres-live-journal.js';
import { PostgresLiveRiskScope } from '../live/postgres-live-risk-scope.js';
import { PostgresLiveSettlement } from '../live/postgres-live-settlement.js';
import { LiveBoundaryError } from '../live/wallet-authorization.js';
import type { LiveSourceNetwork } from '../live/copy-live-source-evidence.js';

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['filled', 'partial', 'cancelled', 'rejected']);
export interface LiveSettleRequest {
  readonly userId: number; readonly accountId: string; readonly accountAddress: string;
  readonly sourceNetwork: LiveSourceNetwork; readonly leaderAddress: string; readonly key: string;
}
export type LiveSettleOutcome = { kind: 'released' } | { kind: 'unplaced' } | { kind: 'pending' | 'quarantine'; reason: string };

/**
 * Settles one terminal testnet order: scans the account's own fills now
 * (so settlement need not wait for the scheduled follower scan), reads
 * the order's status as settlement evidence, observes the account, and asks
 * Codex's settlement DAL to release the reservation and settle the leg
 * (which a flip's opening leg waits for). Read-only at the exchange.
 */
export class CopyLiveSettler {
  constructor(private readonly pool: Pool, private readonly global: HyperliquidGlobalTransport, private readonly budget: RequestBudgeterService,
    private readonly scanner: { runFor(accountId: string): Promise<void> }, private readonly now = Date.now) {}

  private acquire = (weight: number) => this.budget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) });

  async settle(request: LiveSettleRequest): Promise<LiveSettleOutcome> {
    const record = await this.record(request.key);
    if (!record || !TERMINAL_STATES.has(record.state)) return { kind: 'pending', reason: 'live_settlement_not_terminal' };
    // Book the account's own fills now (the scheduled scan reaches an account
    // only every two minutes). The scan also advances its proven horizon,
    // which the next order's position projection requires.
    if (record.outcome?.filledSize && record.outcome.filledSize !== '0') await this.scanner.runFor(request.accountId);
    const scope = new PostgresLiveRiskScope(this.pool, this.now);
    return scope.run({ userId: request.userId, network: 'testnet', accountAddress: request.accountAddress,
      source: { network: request.sourceNetwork, leaderAddress: request.leaderAddress } }, async (_scope, session) => this.global.runOriginal(session, async () => {
      this.global.currentQuota();
      const sockets = new HyperliquidAllDexsAccountSource(this.now, undefined, 'testnet', this.global);
      try {
        const resolver = new HyperliquidLiveMarketResolver('testnet', this.acquire, this.global.fetchInfo, this.now);
        const settlement = new PostgresLiveSettlement(this.now);
        const evidence = await this.orderEvidence(record, resolver);
        const observed = await settlement.observe(session, { accountId: request.accountId, key: request.key, evidence });
        if (observed.kind !== 'recorded') return observed;
        // Never placed (expired unknown by cloid): release, nothing to settle.
        if (record.errorCode === NEVER_PLACED) {
          const released = await settlement.releaseNeverPlaced(session, { accountId: request.accountId, key: request.key });
          return released.kind === 'released' ? { kind: 'unplaced' as const } : released;
        }
        const observer = new HyperliquidLiveAccountObserver('testnet', this.acquire, this.global.fetchInfo, this.now, 5000, sockets);
        const snapshot = await observer.observe(request.accountAddress);
        const [reservation] = await session.read(db => db.select({ revision: copyLiveRiskReservations.revision, accountId: copyLiveRiskReservations.accountId,
          strategyId: copyLiveRiskReservations.strategyId }).from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key, request.key)));
        if (!reservation) return { kind: 'pending' as const, reason: 'live_settlement_reservation_missing' };
        const decision = await settlement.settle(session, { accountId: request.accountId, key: request.key, expectedReservationRevision: reservation.revision,
          accountSource: { accountId: request.accountId, userId: request.userId, strategyId: reservation.strategyId, network: 'testnet', accountAddress: request.accountAddress,
            checkedAt: snapshot.completedAt, sourceDigest: snapshot.sourceDigest, quarantined: false, snapshot } });
        return decision.kind === 'release' ? { kind: 'released' as const } : decision;
      } finally { await sockets.close(); }
    }));
  }

  private async record(key: string): Promise<LiveExecutionRecord | null> {
    const [row] = await drizzle(this.pool).select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
    return row ? decodeLiveExecutionRow(row) : null;
  }

  /** Settlement-grade orderStatus by the original cloid (as the transport's
   * queryEvidence), through the shared egress quota. */
  private async orderEvidence(record: LiveExecutionRecord, resolver: HyperliquidLiveMarketResolver): Promise<LiveOrderEvidence> {
    const checkedAt = this.now(), remaining = () => {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now - checkedAt > 5000) throw new LiveBoundaryError('live_boundary_evidence_expired');
      return Math.max(1, 5000 - (now - checkedAt));
    };
    const market = await boundedLiveRead(resolver.resolveAsset(record.action.orders[0]!.a), remaining());
    await boundedLiveRead(this.acquire(20), remaining());
    const response = await boundedLiveRead(this.global.fetchInfo('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'orderStatus', user: record.authorization.accountAddress, oid: record.action.orders[0]!.c }),
      signal: AbortSignal.timeout(remaining()), redirect: 'error' }), remaining());
    if (!response.ok) throw new LiveBoundaryError('exchange_http_failure');
    const raw = await boundedLiveRead(readInfoJson(response, 'live order evidence', 256 * 1024), remaining());
    const completedAt = this.now();
    return parseLiveOrderEvidence({ record, market, raw, checkedAt, completedAt, now: completedAt });
  }
}
