import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, ne } from 'drizzle-orm';
import { copyControls, copyExecutionAccounts, copyLiveExecutions, copyLiveRiskReservations, copyRiskPolicies, copyStrategies, copyStrategyVersions, users } from '@trading-dashboard/shared/database';
import type { DbExecutor } from '../../db/unit-of-work.js';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import { Dec } from '../../common/decimal/dec.js';
import { assessLiveAccountRisk, type LiveAccountRiskInput, type LiveRiskReservation } from './live-account-risk.js';
import { executionKey } from './live-order.js';
import type { LiveExecutionRecord } from './live-execution.js';
import { planLiveReservation, validateLiveReservationPayload, freezeLiveReservation, type LiveReservationPayload, type LiveReservationStored } from './live-risk-reservation.js';
import type { LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { PostgresWalletAuthorizationSource } from './postgres-wallet-authorizations.js';
import { LiveBoundaryError, assertSameAuthorization, assertWalletAuthorization } from './wallet-authorization.js';

type Row = typeof copyLiveRiskReservations.$inferSelect;
type Journal = typeof copyLiveExecutions.$inferSelect;
type Joined = { reservation: Row; journal: Journal };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code = 'live_reservation_record_invalid'): never { throw new LiveBoundaryError(code); }
function check(value: unknown, code?: string): asserts value { if (!value) fail(code); }

/** Narrow unregistered DAL. Only the original guarded SQL session is accepted;
 * no pool, second connection, provider call, paper cash or execution permit. */
export class PostgresLiveReservations {
  private readonly lineage = new WeakMap<LiveRiskDatabaseSession, Map<string, number>>();
  constructor(private readonly now = Date.now) {}
  private fresh(at: number) { const now = this.now(); check(Number.isSafeInteger(at) && Number.isSafeInteger(now) && now >= at && now - at <= 5000, 'live_risk_stale'); }
  private scoped(session: LiveRiskDatabaseSession, userId: number, accountAddress: string) {
    const id = session.scope.identity; check(id.network === 'testnet' && id.userId === userId && id.accountAddress === accountAddress, 'live_reservation_scope_mismatch'); session.scope.assertFresh();
  }
  private async sql<T>(session: LiveRiskDatabaseSession, query: PromiseLike<T>): Promise<T> { const result = await query; await session.scope.assertHeld(); return result; }
  private decode(row: Row): Readonly<LiveReservationStored> {
    const payload = validateLiveReservationPayload(row.payload), market = payload.intent.market!;
    for (const field of ['key', 'accountId', 'userId', 'strategyId', 'network', 'accountAddress', 'fingerprint', 'walletId', 'authorizationId', 'strategyVersion', 'policyVersion',
      'authorizationVersion', 'notionalUsd', 'marginUsd', 'feeBufferUsd', 'sourceDigest'] as const) check(row[field] === payload[field]);
    check(row.cloid === payload.intent.cloid && row.coin === market.coin && row.dex === market.dex && row.asset === payload.intent.asset &&
      row.createdAt.getTime() === payload.createdAt && row.expiresAt.getTime() === payload.expiresAt && row.updatedAt.getTime() >= payload.createdAt && Number.isSafeInteger(row.revision) && row.revision > 0);
    check(['held', 'unknown', 'resting', 'released', 'quarantined'].includes(row.state));
    check(row.exchangeOrderId === null || /^[1-9]\d*$/.test(row.exchangeOrderId));
    check(row.state !== 'held' || row.attemptedAt === null && row.exchangeOrderId === null);
    check(!['unknown', 'resting'].includes(row.state) || row.attemptedAt !== null);
    check(row.state !== 'resting' || row.exchangeOrderId !== null);
    return freezeLiveReservation({ payload, state: row.state, revision: row.revision, exchangeOrderId: row.exchangeOrderId,
      attemptedAt: row.attemptedAt?.getTime() ?? null, releaseEvidenceDigest: row.releaseEvidenceDigest, updatedAt: row.updatedAt.getTime() });
  }
  private journal(row: Journal, p: LiveReservationPayload): LiveExecutionRecord {
    const record = row.record as unknown as LiveExecutionRecord;
    check(record && row.key === p.key && row.accountAddress === p.accountAddress && row.network === p.network && row.userId === p.userId && row.strategyId === p.strategyId &&
      row.cloid === p.intent.cloid && record.key === p.key && record.fingerprint === p.fingerprint && record.state === row.state &&
      record.nonce === row.nonce && Number.isSafeInteger(record.nonce) && record.nonce >= record.createdAt &&
      Number.isSafeInteger(record.createdAt) && record.createdAt <= p.createdAt && Number.isSafeInteger(record.updatedAt) && record.updatedAt >= record.createdAt && record.updatedAt === row.updatedAt.getTime() &&
      Number.isSafeInteger(record.expiresAfter) && record.expiresAfter === p.expiresAt && record.expiresAfter > record.createdAt && record.expiresAfter <= record.createdAt + 60000 &&
      isDeepStrictEqual(record.market, p.intent.market) && isDeepStrictEqual(record.action, p.action) && record.authorization &&
      record.authorization.id === p.authorizationId && record.authorization.version === p.authorizationVersion && record.authorization.walletId === p.walletId &&
      record.authorization.userId === p.userId && record.authorization.strategyId === p.strategyId && record.authorization.network === p.network &&
      record.authorization.accountAddress === p.accountAddress && record.authorization.signerAddress === row.signerAddress);
    return record;
  }
  private async account(session: LiveRiskDatabaseSession, db: DbExecutor, accountId: string) {
    const [account] = await this.sql(session, db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId)));
    check(account && account.state === 'ready' && account.network === 'testnet' && account.address, 'live_reservation_account_unavailable');
    this.scoped(session, account.userId, account.address);
    const [owner] = await this.sql(session, db.select().from(users).where(eq(users.id, account.userId)));
    check(owner && owner.disabledAt === null && owner.privyUserId === account.privyUserId, 'live_reservation_owner_unavailable'); return account;
  }
  private async rows(session: LiveRiskDatabaseSession, db: DbExecutor, accountId: string) {
    await this.account(session, db, accountId);
    const rows = await this.sql(session, db.select({ reservation: copyLiveRiskReservations, journal: copyLiveExecutions }).from(copyLiveRiskReservations)
      .innerJoin(copyLiveExecutions, eq(copyLiveExecutions.key, copyLiveRiskReservations.key)).where(and(eq(copyLiveRiskReservations.network, 'testnet'),
        eq(copyLiveRiskReservations.accountAddress, session.scope.identity.accountAddress), ne(copyLiveRiskReservations.state, 'released'))).orderBy(copyLiveRiskReservations.key).limit(5002));
    check(rows.length <= 5001, 'live_reservation_coverage_unbounded');
    for (const row of rows) {
      check(row.reservation.accountId === accountId && row.reservation.userId === session.scope.identity.userId, 'live_reservation_scope_mismatch');
      const stored = this.decode(row.reservation); this.journal(row.journal, stored.payload); check(stored.state !== 'quarantined', 'live_reservation_quarantined');
    }
    return rows;
  }
  private view(row: Joined, own: boolean): LiveRiskReservation {
    const stored = this.decode(row.reservation), record = this.journal(row.journal, stored.payload);
    check(stored.state !== 'released' && stored.state !== 'quarantined');
    const state = stored.state === 'held' && record.state !== 'prepared' && !(own && record.state === 'submitting') ? 'unknown' : stored.state;
    return freezeLiveReservation({ ...stored.payload, state, exchangeOrderId: stored.exchangeOrderId }) as LiveRiskReservation;
  }
  private proof(accountId: string, session: LiveRiskDatabaseSession, own: LiveRiskReservation, others: LiveRiskReservation[], checkedAt: number): LiveAccountRiskInput['reservations'] {
    check(others.length <= 5000, 'live_reservation_coverage_unbounded');
    return freezeLiveReservation({ accountId, userId: session.scope.identity.userId, network: 'testnet' as const, accountAddress: session.scope.identity.accountAddress,
      checkedAt, sourceDigest: hash({ accountId, identity: session.scope.identity, own, others, checkedAt }), complete: true as const, own, others });
  }
  private async local(session: LiveRiskDatabaseSession, db: DbExecutor, input: LiveAccountRiskInput, record: LiveExecutionRecord) {
    const account = await this.account(session, db, input.identity.accountId);
    check(account.strategyId === input.identity.strategyId);
    const [strategy] = await this.sql(session, db.select().from(copyStrategies).where(eq(copyStrategies.id, account.strategyId)));
    const [version] = await this.sql(session, db.select().from(copyStrategyVersions).where(and(eq(copyStrategyVersions.strategyId, account.strategyId), eq(copyStrategyVersions.version, input.identity.strategyVersion))));
    check(strategy && strategy.userId === account.userId && !['stopped', 'stopping'].includes(strategy.status) && strategy.version === input.identity.strategyVersion &&
      Dec.from(strategy.allocated).eq(input.strategy.allocatedUsd) &&
      version && isDeepStrictEqual(version.settings, input.strategy.settings), 'live_reservation_strategy_changed');
    const [policy] = await this.sql(session, db.select().from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(1));
    check(policy && policy.version === input.identity.policyVersion && isDeepStrictEqual(policy.limits, input.policy.limits), 'live_reservation_policy_changed');
    const controls = await this.sql(session, db.select().from(copyControls).where(eq(copyControls.scope, 'platform')));
    const userControls = await this.sql(session, db.select().from(copyControls).where(and(eq(copyControls.scope, 'user'), eq(copyControls.scopeId, account.userId))));
    check(controls.length === 1 && controls[0]!.scopeId === 0 && userControls.length === 1, 'live_reservation_controls_unproven');
    for (const [actual, supplied] of [[controls[0]!, input.controls.platform], [userControls[0]!, input.controls.user], [strategy, input.controls.strategy]] as const)
      check(actual.pauseNewRisk === supplied.pauseNewRisk && actual.reduceOnly === supplied.reduceOnly, 'live_reservation_controls_changed');
    const current = await this.sql(session, new PostgresWalletAuthorizationSource(db as DrizzleDb).find(input.identity.authorizationId));
    const grant = assertWalletAuthorization(current, input.intent, this.now());
    check(grant.version === input.identity.authorizationVersion, 'wallet_authorization_changed'); assertSameAuthorization(record.authorization, grant);
  }
  async hold(session: LiveRiskDatabaseSession, raw: LiveAccountRiskInput): Promise<Readonly<LiveReservationStored>> {
    const input = structuredClone(raw); this.scoped(session, input.identity.userId, input.identity.accountAddress);
    const checkedAt = this.now();
    const oldest = Math.min(checkedAt, input.localSource.checkedAt, input.accountSource.checkedAt, input.accountSource.snapshot.observedAt,
      input.accountSource.snapshot.completedAt, input.accountSource.snapshot.coverage.earliestProviderTime, ...input.accountSource.snapshot.dexes.map(d => d.providerTime),
      input.market.observedAt, input.intent.market?.observedAt ?? NaN, input.quote.market.observedAt,
      input.quote.observedAt, input.fees.observedAt, input.userExposureProof.checkedAt, ...input.leverageProofs.map(p => p.observedAt));
    const stored = await session.transaction(async tx => {
      const [journal] = await this.sql(session, tx.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, executionKey(input.intent))).for('update'));
      check(journal && journal.state === 'prepared', 'live_reservation_not_prepared');
      const expiresAt = (journal.record as unknown as LiveExecutionRecord).expiresAfter;
      const candidate = planLiveReservation({ now: this.now(), identity: input.identity, localSource: input.localSource, intent: input.intent, action: input.action,
        market: input.market, quote: input.quote, leverage: input.leverageProofs.find(p => p.coin === input.market.coin)!, fees: input.fees, policy: input.policy, expiresAt });
      const record = this.journal(journal, candidate); await this.local(session, tx, input, record);
      const rows = await this.rows(session, tx, candidate.accountId), existing = rows.find(row => row.reservation.key === candidate.key);
      if (existing) check(existing.reservation.state === 'held' && existing.reservation.fingerprint === candidate.fingerprint &&
        existing.reservation.strategyVersion === candidate.strategyVersion && existing.reservation.policyVersion === candidate.policyVersion && existing.reservation.authorizationVersion === candidate.authorizationVersion, 'live_reservation_replay_conflict');
      const own = existing ? this.view(existing, true) : { ...candidate, state: 'held' as const, exchangeOrderId: null };
      const reservations = this.proof(candidate.accountId, session, own, rows.filter(row => row.reservation.key !== candidate.key).map(row => this.view(row, false)), checkedAt);
      const result = assessLiveAccountRisk({ ...input, now: this.now(), reservations }); check(result.ok, result.ok ? undefined : result.reason);
      if (existing) { const stored = this.decode(existing.reservation); this.fresh(oldest); return stored; }
      const [row] = await this.sql(session, tx.insert(copyLiveRiskReservations).values({ key: candidate.key, accountId: candidate.accountId, userId: candidate.userId,
        strategyId: candidate.strategyId, network: candidate.network, accountAddress: candidate.accountAddress, cloid: candidate.intent.cloid, fingerprint: candidate.fingerprint,
        walletId: candidate.walletId, authorizationId: candidate.authorizationId, strategyVersion: candidate.strategyVersion, policyVersion: candidate.policyVersion,
        authorizationVersion: candidate.authorizationVersion, coin: candidate.intent.market!.coin, dex: candidate.intent.market!.dex, asset: candidate.intent.asset,
        notionalUsd: candidate.notionalUsd, marginUsd: candidate.marginUsd, feeBufferUsd: candidate.feeBufferUsd, payload: candidate as unknown as Record<string, unknown>,
        sourceDigest: candidate.sourceDigest, expiresAt: new Date(candidate.expiresAt), createdAt: new Date(candidate.createdAt), updatedAt: new Date(candidate.createdAt) }).returning());
      const final = assessLiveAccountRisk({ ...input, now: this.now(), reservations }); check(final.ok, final.ok ? undefined : final.reason);
      const stored = this.decode(row!); session.scope.assertFresh(); this.fresh(oldest); return stored;
    });
    session.scope.assertFresh(); this.fresh(oldest);
    const owned = this.lineage.get(session) ?? new Map<string, number>(); owned.set(stored.payload.key, stored.revision); this.lineage.set(session, owned);
    return stored;
  }
  async read(session: LiveRiskDatabaseSession, raw: { accountId: string; ownKey: string }): Promise<LiveAccountRiskInput['reservations']> {
    const input = structuredClone(raw);
    const checkedAt = this.now();
    const result = await session.read(async db => {
      const rows = await this.rows(session, db, input.accountId), own = rows.find(row => row.reservation.key === input.ownKey);
      check(own, 'live_reservation_own_missing');
      const original = this.lineage.get(session)?.get(own.reservation.key) === own.reservation.revision;
      const proof = this.proof(input.accountId, session, this.view(own, original), rows.filter(row => row !== own).map(row => this.view(row, false)), checkedAt);
      this.fresh(checkedAt); return proof;
    });
    session.scope.assertFresh(); this.fresh(checkedAt); return result;
  }
  async recover(session: LiveRiskDatabaseSession, accountId: string): Promise<void> {
    await session.transaction(async tx => {
      const rows = await this.rows(session, tx, accountId);
      for (const row of rows) if (row.reservation.state === 'held' && row.journal.state !== 'prepared') {
        const changed = await this.sql(session, tx.update(copyLiveRiskReservations).set({ state: 'unknown', attemptedAt: new Date(Math.max(row.reservation.createdAt.getTime(), row.journal.updatedAt.getTime())),
          revision: row.reservation.revision + 1, updatedAt: new Date(this.now()) }).where(and(eq(copyLiveRiskReservations.key, row.reservation.key), eq(copyLiveRiskReservations.revision, row.reservation.revision))).returning({ key: copyLiveRiskReservations.key }));
        check(changed.length === 1, 'live_reservation_revision_changed');
      }
    });
  }
  async releaseUnattemptedExpired(session: LiveRiskDatabaseSession, key: string): Promise<void> {
    await session.transaction(async tx => {
      const [joined] = await this.sql(session, tx.select({ reservation: copyLiveRiskReservations, journal: copyLiveExecutions }).from(copyLiveRiskReservations)
        .innerJoin(copyLiveExecutions, eq(copyLiveExecutions.key, copyLiveRiskReservations.key)).where(eq(copyLiveRiskReservations.key, key)).for('update'));
      check(joined); const stored = this.decode(joined.reservation), record = this.journal(joined.journal, stored.payload);
      await this.account(session, tx, stored.payload.accountId);
      check(stored.state === 'held' && stored.attemptedAt === null && stored.exchangeOrderId === null && record.state === 'prepared' && record.expiresAfter <= this.now(), 'live_reservation_release_unproven');
      const changed = await this.sql(session, tx.update(copyLiveRiskReservations).set({ state: 'released', releaseReason: 'unattempted_expired',
        releaseEvidenceDigest: hash({ record, endedAt: this.now() }), revision: stored.revision + 1, updatedAt: new Date(this.now()) })
        .where(and(eq(copyLiveRiskReservations.key, key), eq(copyLiveRiskReservations.revision, stored.revision))).returning({ key: copyLiveRiskReservations.key }));
      check(changed.length === 1, 'live_reservation_revision_changed');
    });
  }
}
