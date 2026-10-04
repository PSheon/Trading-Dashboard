import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, sql, type AnyColumn } from 'drizzle-orm';
import { copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyFundingOperations, copyLiveDispatches, copyLiveExecutions, copyLiveManualCloses, copyLiveMandates,
  copyLiveStopOperations, copyStrategies, copyWalletAuthorizationEvents, copyWalletAuthorizations, users } from '@trading-dashboard/shared/database';
import type { AdminLiveAccount, AdminLiveLatency, AdminLiveOrder, AdminLiveTransfer } from '@trading-dashboard/shared/contracts';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import { lockCopyUser } from './copy-user-lock.js';

const LIMIT = 200;
const OPEN = ['prepared', 'submitting', 'unknown', 'resting'] as const;
const lower = (value: string | null) => value?.toLowerCase() ?? null;
const iso = (value: Date | null) => value?.toISOString() ?? null;
const latest = <T extends { createdAt: Date }>(rows: T[], match: (row: T) => boolean) => rows.filter(match).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;

/**
 * B16/B18 read model for the admin: every testnet execution wallet with its
 * agent, grant, mandate and stop; copy wallet transfers; journal orders by
 * state; leader fill → order latency. SQL only, no exchange calls.
 */
@Injectable()
export class CopyAdminLiveRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async accounts(): Promise<AdminLiveAccount[]> {
    const rows = await this.db.select({ account: copyExecutionAccounts, strategy: copyStrategies, email: users.email }).from(copyExecutionAccounts)
      .innerJoin(copyStrategies, eq(copyStrategies.id, copyExecutionAccounts.strategyId)).innerJoin(users, eq(users.id, copyExecutionAccounts.userId))
      .where(eq(copyExecutionAccounts.network, 'testnet')).orderBy(desc(copyExecutionAccounts.createdAt)).limit(LIMIT);
    if (!rows.length) return [];
    const ids = rows.map(r => r.account.id);
    const [setups, mandates, stops] = await Promise.all([
      this.db.select().from(copyAgentSetups).where(inArray(copyAgentSetups.accountId, ids)),
      this.db.select().from(copyLiveMandates).where(inArray(copyLiveMandates.accountId, ids)),
      this.db.select().from(copyLiveStopOperations).where(inArray(copyLiveStopOperations.accountId, ids)),
    ]);
    const grantIds = [...new Set(mandates.map(m => m.authorizationId))];
    const grants = grantIds.length ? await this.db.select().from(copyWalletAuthorizations).where(inArray(copyWalletAuthorizations.id, grantIds)) : [];
    return rows.map(({ account: a, strategy: s, email }) => {
      const setup = latest(setups, x => x.accountId === a.id), mandate = latest(mandates, x => x.accountId === a.id);
      const stop = latest(stops, x => x.accountId === a.id && x.state !== 'stopped'), grant = mandate ? grants.find(g => g.id === mandate.authorizationId) ?? null : null;
      return {
        accountId: a.id, userId: a.userId, userEmail: email, strategyId: a.strategyId, leaderAddress: s.leaderAddress.toLowerCase(),
        sourceNetwork: mandate?.sourceNetwork ?? 'testnet', accountAddress: lower(a.address), accountState: a.state, strategyStatus: s.status,
        agent: setup ? { setupId: setup.id, state: setup.state, agentAddress: lower(setup.agentAddress), expiresAt: setup.expiresAt.toISOString() } : null,
        grant: grant ? { id: grant.id, version: grant.version, scopes: grant.scopes, expiresAt: grant.expiresAt.toISOString(), revokedAt: iso(grant.revokedAt), revokeRequestedAt: iso(grant.revokeRequestedAt) } : null,
        mandate: mandate ? { id: mandate.id, state: mandate.state, revision: mandate.revision } : null,
        stop: stop ? { id: stop.id, state: stop.state, issue: stop.issue } : null,
        createdAt: a.createdAt.toISOString(),
      };
    });
  }

  async transfers(): Promise<AdminLiveTransfer[]> {
    const rows = await this.db.select().from(copyFundingOperations).where(eq(copyFundingOperations.network, 'testnet')).orderBy(desc(copyFundingOperations.createdAt)).limit(LIMIT);
    return rows.map(r => ({ id: r.id, userId: r.userId, accountId: r.accountId, strategyId: r.strategyId, direction: r.direction, status: r.status, amount: r.amount,
      source: r.address.toLowerCase(), destination: r.destination.toLowerCase(), stopId: r.stopId, transactionHash: r.transactionHash, attemptedAt: iso(r.attemptedAt),
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }));
  }

  /** `open`: not yet terminal (prepared, submitting, unknown, resting);
   * `unknown`: sent or being sent, the exchange outcome not yet confirmed. */
  async orders(filter: 'open' | 'unknown' | 'all'): Promise<AdminLiveOrder[]> {
    const states = filter === 'open' ? [...OPEN] : filter === 'unknown' ? ['submitting', 'unknown'] : null;
    const rows = await this.db.select().from(copyLiveExecutions)
      .where(and(eq(copyLiveExecutions.network, 'testnet'), states ? inArray(copyLiveExecutions.state, states) : undefined))
      .orderBy(desc(copyLiveExecutions.updatedAt)).limit(LIMIT);
    if (!rows.length) return [];
    const keys = rows.map(r => r.key);
    const [legs, closes] = await Promise.all([
      this.db.select().from(copyLiveDispatches).where(inArray(copyLiveDispatches.executionKey, keys)),
      this.db.select({ keys: copyLiveManualCloses.executionKeys }).from(copyLiveManualCloses).where(sql`${copyLiveManualCloses.executionKeys} ?| array[${sql.join(keys.map(k => sql`${k}`), sql`, `)}]::text[]`),
    ]);
    const manual = new Set(closes.flatMap(c => c.keys));
    return rows.map(r => {
      const record = r.record as { action?: { orders?: [{ b: boolean; p: string; s: string; r: boolean }] }; market?: { coin?: string }; errorCode?: string; createdAt?: number };
      const order = record.action?.orders?.[0], leg = legs.find(l => l.executionKey === r.key) ?? null;
      return { key: r.key, userId: r.userId, strategyId: r.strategyId, accountAddress: r.accountAddress.toLowerCase(), coin: record.market?.coin ?? leg?.coin ?? null,
        side: order?.b ? 'B' : 'A', size: order?.s ?? '0', limitPrice: order?.p ?? '0', reduceOnly: order?.r ?? false, state: r.state, errorCode: record.errorCode ?? null,
        purpose: leg ? 'copy' : manual.has(r.key) ? 'close' : order?.r ? 'stop' : 'other',
        leg: leg ? { leg: leg.leg, state: leg.state, reason: leg.reason } : null,
        createdAt: new Date(typeof record.createdAt === 'number' ? record.createdAt : r.updatedAt.getTime()).toISOString(), updatedAt: r.updatedAt.toISOString() } satisfies AdminLiveOrder;
    });
  }

  /** P50/P95 milliseconds from the leader's fill time to: the worker seeing
   * the fill (signal), the order leaving (sent), the exchange's answer (ack),
   * and the fill booked (settled). Legs whose leader fill is in the window. */
  async latency(window: '24h' | '7d', now: Date): Promise<AdminLiveLatency> {
    const since = new Date(now.getTime() - (window === '24h' ? 86_400_000 : 7 * 86_400_000));
    const ms = (column: AnyColumn) => sql`extract(epoch from (${column} - ${copyLiveDispatches.leaderTime})) * 1000`;
    const pct = (p: number, column: Parameters<typeof ms>[0]) => sql<string | null>`percentile_cont(${sql.raw(String(p))}) within group (order by ${ms(column)})`;
    const [row] = await this.db.select({ count: sql<number>`count(*)::int`,
      signal50: pct(0.5, copyLiveDispatches.receivedAt), signal95: pct(0.95, copyLiveDispatches.receivedAt),
      sent50: pct(0.5, copyLiveDispatches.sentAt), sent95: pct(0.95, copyLiveDispatches.sentAt),
      ack50: pct(0.5, copyLiveDispatches.ackedAt), ack95: pct(0.95, copyLiveDispatches.ackedAt),
      settled50: pct(0.5, copyLiveDispatches.settledAt), settled95: pct(0.95, copyLiveDispatches.settledAt),
    }).from(copyLiveDispatches).where(gte(copyLiveDispatches.leaderTime, since));
    const n = (value: string | number | null | undefined) => value === null || value === undefined ? null : Math.round(Number(value));
    return { window, count: row?.count ?? 0, signal: { p50: n(row?.signal50), p95: n(row?.signal95) }, sent: { p50: n(row?.sent50), p95: n(row?.sent95) },
      ack: { p50: n(row?.ack50), p95: n(row?.ack95) }, settled: { p50: n(row?.settled50), p95: n(row?.settled95) } };
  }

  /** The grant row locked for an admin revoke (any user's testnet wallet). */
  async lockedGrant(tx: DbTransaction, id: string) {
    // The owner's own revoke locks the user, then the grant: same order here.
    const [owner] = await tx.select({ userId: copyExecutionWallets.userId }).from(copyWalletAuthorizations)
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId)).where(eq(copyWalletAuthorizations.id, id));
    if (!owner) return undefined;
    await lockCopyUser(tx, owner.userId);
    return (await tx.select({ grant: copyWalletAuthorizations, wallet: copyExecutionWallets }).from(copyWalletAuthorizations)
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .where(and(eq(copyWalletAuthorizations.id, id), eq(copyExecutionWallets.network, 'testnet'))).for('update', { of: copyWalletAuthorizations }))[0];
  }
  /** The copy behind this grant: its strategy, the account's newest
   * generation that was ever activated and not stopped (active, paused,
   * revoked or expired: its positions may still be there), and the stop that
   * has not ended. Decided by the account, not by the newest mandate: a
   * renewal still prepared must not hide an older activated generation's
   * positions. */
  async grantCopy(tx: DbTransaction, id: string) {
    const [first] = await tx.select({ accountId: copyLiveMandates.accountId, strategyId: copyLiveMandates.strategyId }).from(copyLiveMandates)
      .where(eq(copyLiveMandates.authorizationId, id)).orderBy(desc(copyLiveMandates.createdAt)).limit(1);
    if (!first) return null;
    const [strategy] = await tx.select().from(copyStrategies).where(eq(copyStrategies.id, first.strategyId));
    const [activated] = await tx.select().from(copyLiveMandates)
      .where(and(eq(copyLiveMandates.accountId, first.accountId), sql`${copyLiveMandates.activationCursor} is not null`, sql`${copyLiveMandates.state} <> 'stopped'`))
      .orderBy(desc(copyLiveMandates.createdAt)).limit(1);
    const [stop] = await tx.select().from(copyLiveStopOperations)
      .where(and(eq(copyLiveStopOperations.accountId, first.accountId), sql`${copyLiveStopOperations.state} <> 'stopped'`)).limit(1);
    return { strategy: strategy ?? null, activated: activated ?? null, stop: stop ?? null };
  }
  /** Not a new version: the stop's closes are signed under the version the
   * copy's orders carry; the version moves when the grant is revoked. */
  async requestRevoke(tx: DbTransaction, id: string, now: Date) {
    return (await tx.update(copyWalletAuthorizations).set({ revokeRequestedAt: now }).where(eq(copyWalletAuthorizations.id, id)).returning())[0]!;
  }
  async revokeGrant(tx: DbTransaction, id: string, version: number, now: Date) {
    return (await tx.update(copyWalletAuthorizations).set({ revokedAt: now, version }).where(eq(copyWalletAuthorizations.id, id)).returning())[0]!;
  }
  recordRevocation(tx: DbTransaction, event: typeof copyWalletAuthorizationEvents.$inferInsert) {
    return tx.insert(copyWalletAuthorizationEvents).values(event);
  }
}
