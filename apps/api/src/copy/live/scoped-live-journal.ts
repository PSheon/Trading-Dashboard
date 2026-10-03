import { eq } from 'drizzle-orm';
import { copyLiveExecutions } from '@trading-dashboard/shared/database';
import { isDeepStrictEqual } from 'node:util';
import type { LiveExecutionJournal, LiveExecutionRecord } from './live-execution.js';
import type { LiveExecutionLease } from './live-execution-gate.js';
import type { LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { decodeLiveExecutionRow, immutableLiveExecution, liveExecutionTransitions } from './postgres-live-journal.js';
import { marketIdentityKey } from './live-market-resolver.js';
import { assertSameAuthorization, LiveBoundaryError } from './wallet-authorization.js';

/** Executor adapter on the original owner/account/source lock connection.
 * Preparation must already have committed atomically with trusted source
 * provenance and the generation baseline. This adapter allocates no nonce,
 * starts no replacement scope and is not a financial admission producer. */
export class ScopedLiveExecutionJournal implements LiveExecutionJournal {
  private activeOrder = false;
  constructor(private readonly session: LiveRiskDatabaseSession, private readonly key: string) {
    this.assertKey(key);
  }
  private assertKey(key: string): void {
    this.session.scope.assertFresh();
    const identity = this.session.scope.identity, prefix = `${identity.network}:${identity.accountAddress}:`;
    if (key !== this.key || !key.startsWith(prefix) || !/^0x[0-9a-f]{32}$/.test(key.slice(prefix.length)))
      throw new LiveBoundaryError('execution_record_scope_mismatch');
  }
  private decode(row: typeof copyLiveExecutions.$inferSelect): LiveExecutionRecord {
    const identity = this.session.scope.identity;
    if (row.userId !== identity.userId || row.network !== identity.network || row.accountAddress !== identity.accountAddress || row.key !== this.key)
      throw new LiveBoundaryError('execution_record_scope_mismatch');
    return structuredClone(decodeLiveExecutionRow(row));
  }
  async withOrderLock<T>(key: string, work: (lease: LiveExecutionLease) => Promise<T>): Promise<T> {
    this.assertKey(key);
    if (this.activeOrder) throw new LiveBoundaryError('execution_busy');
    this.activeOrder = true;
    let live = true;
    const lease = Object.freeze({ assertHeld: async () => {
      if (!live) throw new LiveBoundaryError('execution_lease_lost');
      await this.session.scope.assertHeld();
      if (!live) throw new LiveBoundaryError('execution_lease_lost');
    } });
    try { await lease.assertHeld(); return await work(lease); }
    finally { live = false; this.activeOrder = false; }
  }
  async get(key: string): Promise<LiveExecutionRecord | null> {
    this.assertKey(key);
    return this.session.read(async db => {
      const [row] = await db.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
      await this.session.scope.assertHeld();
      return row ? this.decode(row) : null;
    });
  }
  async prepare(supplied: Parameters<LiveExecutionJournal['prepare']>[0]): Promise<LiveExecutionRecord> {
    const input = structuredClone(supplied);
    this.assertKey(input.key);
    const record = await this.get(input.key);
    if (!record) throw new LiveBoundaryError('execution_record_missing');
    if (record.fingerprint !== input.fingerprint) throw new LiveBoundaryError('cloid_payload_conflict');
    if (!isDeepStrictEqual(record.action, input.action)) throw new LiveBoundaryError('persisted_order_payload_mismatch');
    if (!isDeepStrictEqual(record.market ? marketIdentityKey(record.market) : undefined, input.market ? marketIdentityKey(input.market) : undefined))
      throw new LiveBoundaryError('persisted_order_market_mismatch');
    assertSameAuthorization(record.authorization, input.authorization);
    this.session.scope.assertFresh();
    return record;
  }
  async save(supplied: LiveExecutionRecord): Promise<void> {
    const record = structuredClone(supplied);
    this.assertKey(record.key);
    await this.session.transaction(async tx => {
      const [row] = await tx.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, record.key)).for('update');
      await this.session.scope.assertHeld();
      if (!row) throw new LiveBoundaryError('execution_record_missing');
      const current = this.decode(row);
      if (!isDeepStrictEqual(immutableLiveExecution(current), immutableLiveExecution(record))) throw new LiveBoundaryError('execution_record_immutable');
      if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < current.updatedAt || record.outcome && record.outcome.state !== record.state)
        throw new LiveBoundaryError('execution_record_invalid');
      if (isDeepStrictEqual(current, JSON.parse(JSON.stringify(record)))) return;
      if (!liveExecutionTransitions[current.state].includes(record.state)) throw new LiveBoundaryError('execution_state_transition_denied');
      await tx.update(copyLiveExecutions).set({ state: record.state, record: record as unknown as Record<string, unknown>, updatedAt: new Date(record.updatedAt) })
        .where(eq(copyLiveExecutions.key, record.key));
      await this.session.scope.assertHeld();
    });
  }
}
