import type { Pool } from 'pg';
import { LiveBoundaryError, type LiveNetwork } from './wallet-authorization.js';

export interface LiveRiskIdentity {
  readonly userId: number;
  readonly network: LiveNetwork;
  readonly accountAddress: string;
}
export interface LiveRiskScope {
  readonly identity: Readonly<LiveRiskIdentity>;
  /** Confirms both original session locks. Include this check in the execution
   * lease after every asynchronous provider/SQL operation. */
  assertHeld(): Promise<void>;
  /** Synchronous boundary check tied to this scope, never a successor scope. */
  assertFresh(): void;
}
function fail(code: string): never { throw new LiveBoundaryError(code); }
function capture(value: LiveRiskIdentity): Readonly<LiveRiskIdentity> {
  if (!value || !Number.isSafeInteger(value.userId) || value.userId <= 0 || value.userId > 2147483647 ||
      !['testnet', 'mainnet'].includes(value.network) || typeof value.accountAddress !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.accountAddress) || /^0x0{40}$/i.test(value.accountAddress))
    fail('live_risk_invalid_identity');
  return Object.freeze({ userId: value.userId, network: value.network, accountAddress: value.accountAddress.toLowerCase() });
}

/** Serializes the user's cross-account exposure and the trading account's
 * collateral on one crash-released SQL session. No SQL transaction crosses
 * provider calls. This primitive does not grant consent or fabricate risk data;
 * a proof producer must still load current ownership and complete liabilities. */
export class PostgresLiveRiskScope {
  constructor(private readonly pool: Pool, private readonly now = Date.now) {}
  async run<T>(rawIdentity: LiveRiskIdentity, work: (scope: LiveRiskScope) => Promise<T>): Promise<T> {
    const identity = capture(rawIdentity);
    // Match the existing transaction writer locks exactly. User limits and
    // controls are global across networks, so this lock deliberately is too.
    const accountKey = `live-risk-account:${identity.network}:${identity.accountAddress}`;
    const locks = [
      { acquire: 'select pg_try_advisory_lock_shared(7403, 0) as locked', release: 'select pg_advisory_unlock_shared(7403, 0) as unlocked', values: [] as (string | number)[] },
      { acquire: 'select pg_try_advisory_lock_shared(7405, 0) as locked', release: 'select pg_advisory_unlock_shared(7405, 0) as unlocked', values: [] as (string | number)[] },
      { acquire: 'select pg_try_advisory_lock(7404, $1::integer) as locked', release: 'select pg_advisory_unlock(7404, $1::integer) as unlocked', values: [identity.userId] },
      { acquire: 'select pg_try_advisory_lock(hashtextextended($1, 7)) as locked', release: 'select pg_advisory_unlock(hashtextextended($1, 7)) as unlocked', values: [accountKey] },
    ];
    const client = await this.pool.connect();
    const acquired: typeof locks = [];
    let held = false, lost = false, checkedAt = NaN;
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
          select count(*) = 4 as held from pg_locks where pid = pg_backend_pid()
            and locktype = 'advisory' and granted
            and ((objsubid = 2 and mode = 'ShareLock' and classid::bigint in (7403,7405) and objid::bigint = 0)
              or (objsubid = 2 and mode = 'ExclusiveLock' and classid::bigint = 7404 and objid::bigint = $1)
              or (objsubid = 1 and mode = 'ExclusiveLock' and classid::bigint = ((hashtextextended($2, 7) >> 32) & 4294967295)
                and objid::bigint = (hashtextextended($2, 7) & 4294967295)))`, [identity.userId, accountKey]);
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
    try {
      // Stable policy -> platform -> user -> account order. Try rather than wait: no provider budget
      // or prepared order can be consumed by a concurrent owner of this scope.
      for (const lock of locks) {
        const result = await client.query<{ locked: boolean }>(lock.acquire, lock.values);
        if (lost || result.rows[0]?.locked !== true) fail('live_risk_busy');
        acquired.push(lock);
      }
      held = true;
      await scope.assertHeld();
      return await work(scope);
    } finally {
      // Tombstone every callback before cleanup releases authority to another
      // worker. A stale closure can never regain it by querying this pool.
      held = false;
      let discard = lost;
      for (const lock of acquired.reverse()) {
        try {
          const result = await client.query<{ unlocked: boolean }>(lock.release, lock.values);
          if (result.rows[0]?.unlocked !== true) discard = true;
        } catch { discard = true; }
      }
      client.removeListener('error', onError);
      client.removeListener('end', onError);
      client.release(discard);
    }
  }
}
