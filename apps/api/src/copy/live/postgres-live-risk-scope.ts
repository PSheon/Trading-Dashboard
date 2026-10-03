import type { Pool } from 'pg';
import * as schema from '@trading-dashboard/shared/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../../db/unit-of-work.js';
import { LiveBoundaryError, type LiveNetwork } from './wallet-authorization.js';

export interface LiveRiskIdentity {
  readonly userId: number;
  readonly network: LiveNetwork;
  readonly accountAddress: string;
  /** Captured before acquiring any authority. Never attach a replacement
   * stream to a running scope after loading or planning source evidence. */
  readonly source?: Readonly<{ network: LiveNetwork; leaderAddress: string }>;
}
export interface LiveRiskScope {
  readonly identity: Readonly<LiveRiskIdentity>;
  /** Confirms both original session locks. Include this check in the execution
   * lease after every asynchronous provider/SQL operation. */
  assertHeld(): Promise<void>;
  /** Synchronous boundary check tied to this scope, never a successor scope. */
  assertFresh(): void;
}
/** Local DAL operations on the original lock connection. Callbacks must only
 * perform SQL; provider I/O belongs outside these callbacks and transactions.
 * Repositories recheck scope after each SQL await and validate immutable rows. */
export interface LiveRiskDatabaseSession {
  readonly scope: LiveRiskScope;
  read<T>(work: (db: DbExecutor) => Promise<T>): Promise<T>;
  transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T>;
}
const originalSessions = new WeakSet<object>();
/** Concrete risk producers accept only capabilities issued by this factory,
 * never a structurally compatible object containing invented SQL results. */
export function assertOriginalLiveRiskSession(session: LiveRiskDatabaseSession): void {
  if (!session || !originalSessions.has(session)) throw new LiveBoundaryError('live_risk_serialization_lost');
  session.scope.assertFresh();
}
function fail(code: string): never { throw new LiveBoundaryError(code); }
function capture(value: LiveRiskIdentity): Readonly<LiveRiskIdentity> {
  if (!value || !Number.isSafeInteger(value.userId) || value.userId <= 0 || value.userId > 2147483647 ||
      !['testnet', 'mainnet'].includes(value.network) || typeof value.accountAddress !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.accountAddress) || /^0x0{40}$/i.test(value.accountAddress))
    fail('live_risk_invalid_identity');
  let source: LiveRiskIdentity['source'];
  if (value.source !== undefined) {
    if (!value.source || !['testnet', 'mainnet'].includes(value.source.network) || typeof value.source.leaderAddress !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.source.leaderAddress) || /^0x0{40}$/i.test(value.source.leaderAddress)) fail('live_risk_invalid_identity');
    source = Object.freeze({ network: value.source.network, leaderAddress: value.source.leaderAddress.toLowerCase() });
  }
  return Object.freeze({ userId: value.userId, network: value.network, accountAddress: value.accountAddress.toLowerCase(), ...(source ? { source } : {}) });
}

/** Serializes the user's cross-account exposure and the trading account's
 * collateral on one crash-released SQL session. No SQL transaction crosses
 * provider calls. This primitive does not grant consent or fabricate risk data;
 * a proof producer must still load current ownership and complete liabilities. */
export class PostgresLiveRiskScope {
  constructor(private readonly pool: Pool, private readonly now = Date.now) {}
  async run<T>(rawIdentity: LiveRiskIdentity, work: (scope: LiveRiskScope, session: LiveRiskDatabaseSession) => Promise<T>): Promise<T> {
    const identity = capture(rawIdentity);
    // Match the existing transaction writer locks exactly. User limits and
    // controls are global across networks, so this lock deliberately is too.
    const accountKey = `live-risk-account:${identity.network}:${identity.accountAddress}`;
    const sourceKey = identity.source ? `live-risk-source:${identity.source.network}:${identity.source.leaderAddress}` : null;
    const locks = [
      { acquire: 'select pg_try_advisory_lock_shared(7403, 0) as locked', release: 'select pg_advisory_unlock_shared(7403, 0) as unlocked', values: [] as (string | number)[] },
      { acquire: 'select pg_try_advisory_lock_shared(7405, 0) as locked', release: 'select pg_advisory_unlock_shared(7405, 0) as unlocked', values: [] as (string | number)[] },
      { acquire: 'select pg_try_advisory_lock(7404, $1::integer) as locked', release: 'select pg_advisory_unlock(7404, $1::integer) as unlocked', values: [identity.userId] },
      { acquire: 'select pg_try_advisory_lock(hashtextextended($1, 7)) as locked', release: 'select pg_advisory_unlock(hashtextextended($1, 7)) as unlocked', values: [accountKey] },
      ...(sourceKey ? [{ acquire: 'select pg_try_advisory_lock_shared(hashtextextended($1, 8)) as locked', release: 'select pg_advisory_unlock_shared(hashtextextended($1, 8)) as unlocked', values: [sourceKey] }] : []),
    ];
    const client = await this.pool.connect();
    const acquired: typeof locks = [];
    let held = false, lost = false, checkedAt = NaN;
    let databaseBusy = false, activeOperation: Promise<unknown> | undefined;
    const onError = () => { lost = true; };
    client.on('error', onError);
    client.on('end', onError);
    const assertFresh = () => {
      if (!held || lost) fail('live_risk_serialization_lost');
      const now = this.now();
      if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(checkedAt) ||
          now < checkedAt || now - checkedAt > 5000) fail('live_risk_serialization_stale');
    };
    const scope: LiveRiskScope = Object.freeze({ identity, assertFresh, assertHeld: async () => {
      if (!held || lost) fail('live_risk_serialization_lost');
      const started = this.now();
      try {
        const result = await client.query<{ held: boolean }>(`
          select count(*) = $4::integer as held from pg_locks where pid = pg_backend_pid()
            and locktype = 'advisory' and granted
            and ((objsubid = 2 and mode = 'ShareLock' and classid::bigint in (7403,7405) and objid::bigint = 0)
              or (objsubid = 2 and mode = 'ExclusiveLock' and classid::bigint = 7404 and objid::bigint = $1)
              or (objsubid = 1 and mode = 'ExclusiveLock' and classid::bigint = ((hashtextextended($2, 7) >> 32) & 4294967295)
                and objid::bigint = (hashtextextended($2, 7) & 4294967295))
              or ($3::text is not null and objsubid = 1 and mode = 'ShareLock'
                and classid::bigint = ((hashtextextended($3::text, 8) >> 32) & 4294967295)
                and objid::bigint = (hashtextextended($3::text, 8) & 4294967295)))`, [identity.userId, accountKey, sourceKey, locks.length]);
        if (!held || lost || result.rows[0]?.held !== true) throw new Error();
        // Timestamp is the beginning of the query, including SQL queue waits.
        checkedAt = started;
        assertFresh();
      } catch (error) {
        lost = true;
        if (error instanceof LiveBoundaryError) throw error;
        fail('live_risk_serialization_lost');
      }
    } });
    const database = drizzle(client, { schema });
    const local = <R>(callback: () => Promise<R>): Promise<R> => {
      try {
        assertFresh();
        if (databaseBusy) fail('live_risk_database_busy');
        if (client.getTransactionStatus() !== 'I') { lost = true; fail('live_risk_database_dirty'); }
      } catch (error) { return Promise.reject(error); }
      databaseBusy = true;
      const operation = (async () => {
        try {
          await scope.assertHeld();
          const result = await callback();
          if (client.getTransactionStatus() !== 'I') { lost = true; fail('live_risk_database_dirty'); }
          await scope.assertHeld();
          return result;
        } catch (error) {
          // A failed rollback or ambiguous transaction completion cannot be
          // repaired by catching the callback error and reusing this scope.
          if (client.getTransactionStatus() !== 'I') lost = true;
          throw error;
        } finally { databaseBusy = false; }
      })();
      activeOperation = operation;
      // Retain the operation for scope teardown, including a mistakenly
      // unawaited callback. Its caller still receives the original rejection.
      void operation.catch(() => {}).finally(() => { if (activeOperation === operation) activeOperation = undefined; });
      return operation;
    };
    const scopedTransaction = <R>(callback: (tx: DbTransaction) => Promise<R>, readOnly = false) => local(() => database.transaction(async tx => {
        await tx.execute(sql`set local statement_timeout = '5000ms'`);
        await tx.execute(sql`set local idle_in_transaction_session_timeout = '5000ms'`);
        await scope.assertHeld();
        const result = await callback(tx);
        // A released/ended original scope must roll back before COMMIT.
        await scope.assertHeld();
        return result;
      }, readOnly ? { isolationLevel: 'repeatable read', accessMode: 'read only' } : undefined));
    const session: LiveRiskDatabaseSession = Object.freeze({ scope,
      read: <R>(callback: (db: DbExecutor) => Promise<R>) => scopedTransaction(callback, true),
      transaction: scopedTransaction,
    });
    try {
      // Never adopt or commit another caller's unfinished SQL transaction.
      if (client.getTransactionStatus() !== 'I') { lost = true; fail('live_risk_database_dirty'); }
      // Stable policy -> platform -> user -> account order. Try rather than wait: no provider budget
      // or prepared order can be consumed by a concurrent owner of this scope.
      for (const lock of locks) {
        const result = await client.query<{ locked: boolean }>(lock.acquire, lock.values);
        if (lost || result.rows[0]?.locked !== true) fail('live_risk_busy');
        acquired.push(lock);
      }
      held = true;
      await scope.assertHeld();
      originalSessions.add(session);
      const result = await work(scope, session);
      if (databaseBusy) fail('live_risk_database_unawaited');
      return result;
    } finally {
      // Tombstone every callback before cleanup releases authority to another
      // worker. A stale closure can never regain it by querying this pool.
      held = false;
      originalSessions.delete(session);
      let discard = lost || client.getTransactionStatus() !== 'I';
      if (activeOperation) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([activeOperation.catch(() => {}), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error()), 5000);
          })]);
        } catch { discard = true; }
        finally { clearTimeout(timer); }
        // A pending callback cannot outlive this connection or return it to
        // the pool with a transaction still open. Destruction releases locks.
        if (databaseBusy) discard = true;
      }
      if (client.getTransactionStatus() !== 'I') discard = true;
      if (!databaseBusy && !discard) {
        for (const lock of acquired.reverse()) {
          try {
            const result = await client.query<{ unlocked: boolean }>(lock.release, lock.values);
            if (result.rows[0]?.unlocked !== true) discard = true;
          } catch { discard = true; }
        }
      }
      client.removeListener('error', onError);
      client.removeListener('end', onError);
      client.release(discard || client.getTransactionStatus() !== 'I');
    }
  }
}
