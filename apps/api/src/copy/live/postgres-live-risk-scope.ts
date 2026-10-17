import type { Pool, PoolClient } from 'pg';
import { performance } from 'node:perf_hooks';
import { acquireSettlementConnection, type SettlementClaim } from '../live-worker/copy-live-settlement-claim.js';
import * as schema from '@trading-dashboard/shared/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { DbExecutor, DbTransaction } from '../../db/unit-of-work.js';
import { LiveBoundaryError, type LiveNetwork } from './wallet-authorization.js';
import { LIVE_RISK_LOCK_POLL_MS, LIVE_RISK_LOCK_WAIT_MS, LOCK_CHECK_REUSE_MS } from '../../config/constants/timings.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { liveEvidenceMaxAgeMs } from '../../config/live-evidence-window.js';

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
  /** `readsFirst`: the work's statements up to its first awaited answer are
   * all plain reads (SELECT without a row lock): they are then sent right
   * behind BEGIN, without waiting for its answer (see the scope). Any other
   * statement sent before BEGIN's answer, a row-locking read (FOR UPDATE,
   * FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE) included, is refused
   * (live_risk_database_dirty). */
  transaction<T>(work: (tx: DbTransaction) => Promise<T>, options?: { readonly readsFirst?: boolean }): Promise<T>;
}
const originalSessions = new WeakSet<object>();
/** Concrete risk producers accept only capabilities issued by this factory,
 * never a structurally compatible object containing invented SQL results. */
export function assertOriginalLiveRiskSession(session: LiveRiskDatabaseSession): void {
  if (!session || !originalSessions.has(session)) throw new LiveBoundaryError('live_risk_serialization_lost');
  session.scope.assertFresh();
}
function fail(code: string): never { throw new LiveBoundaryError(code); }

/** What a scope is held for, so a refused one can say who held it. */
interface LiveRiskHolder { readonly kind: string; readonly id?: string }
/** live_risk_busy, saying which lock was taken and by whom (gate run 9,
 * 2026-10-14: an order waited 12 s for a lock nobody could name). `holders`
 * are this process's scopes on that lock (kind, id, how long held);
 * `sessions` the other sessions of this database pg_locks shows holding it
 * (another process, or a transaction-scoped writer such as source ingestion). */
interface LiveRiskBusyDetail {
  readonly lock: 'policy' | 'platform' | 'user' | 'account' | 'source';
  readonly holders: readonly { kind: string; id: string | null; heldMs: number }[];
  /** `heldMs`: the session's open transaction's age (else since its last
   * state change), not how long it has held the lock: a session lock outlives
   * its transactions. `last`: the table (or advisory-lock function) its
   * latest statement named, which tells the code path apart (gate run 10:
   * an `idle in transaction` holder no process name could identify). */
  readonly sessions: readonly { pid: number; application: string; state: string; heldMs: number | null; last: string }[] | null;
}
export class LiveRiskBusyError extends LiveBoundaryError {
  constructor(readonly detail: LiveRiskBusyDetail) { super('live_risk_busy'); }
}
/** The detail of a live_risk_busy refusal as one JSON line, or ''. */
export const liveRiskBusyDetail = (error: unknown): string => error instanceof LiveRiskBusyError ? JSON.stringify(error.detail) : '';
const SAFE_LABEL = /^[A-Za-z0-9_.:\- ]{0,96}$/;
const label = (value: unknown) => typeof value === 'string' ? (SAFE_LABEL.test(value) ? value : '<text>') : '';
/** This process's scope holders per lock (one worker process holds them). */
const holders = new Map<string, Set<{ kind: string; id: string | null; since: number }>>();
/** Proves the scope's $4 advisory locks are all still held by this session. */
const HELD_SQL = `
          select count(*) = $4::integer as held from pg_locks where pid = pg_backend_pid()
            and locktype = 'advisory' and granted
            and ((objsubid = 2 and mode = 'ShareLock' and classid::bigint in (7403,7405) and objid::bigint = 0)
              or (objsubid = 2 and mode = 'ExclusiveLock' and classid::bigint = 7404 and objid::bigint = $1)
              or (objsubid = 1 and mode = 'ExclusiveLock' and classid::bigint = ((hashtextextended($2, 7) >> 32) & 4294967295)
                and objid::bigint = (hashtextextended($2, 7) & 4294967295))
              or ($3::text is not null and objsubid = 1 and mode = 'ShareLock'
                and classid::bigint = ((hashtextextended($3::text, 8) >> 32) & 4294967295)
                and objid::bigint = (hashtextextended($3::text, 8) & 4294967295)))`;
/** SET LOCAL statement_timeout and idle_in_transaction_session_timeout, as one
 * statement; and the transaction's application_name, the pool's plus what the
 * scope is held for ($1), so a live_risk_busy in another process names its
 * holder (pg_stat_activity) at no extra round trip. */
const TRANSACTION_TIMEOUTS_SQL = "select set_config('statement_timeout', '5000ms', true), set_config('idle_in_transaction_session_timeout', '5000ms', true), set_config('application_name', left(split_part(current_setting('application_name'), ':', 1) || ':' || $1::text, 63), true)";
/**
 * What Drizzle is told BEGIN answered, for a transaction whose reads go out
 * before BEGIN's real answer (see the scope). drizzle-orm (pinned exactly,
 * 0.45.3: node-postgres/session.js `transaction`) awaits
 * `tx.execute(sql\`begin\`)` and never reads its result. Any read of this one
 * throws (live_risk_database_dirty), so a Drizzle that starts reading it
 * fails the transaction instead of acting on an invented answer. Only `then`
 * answers (undefined: not a thenable), because awaiting a value looks it up.
 */
const UNANSWERED_BEGIN: unknown = new Proxy(Object.freeze({}), {
  get: (_target, property) => { if (property === 'then') return undefined; fail('live_risk_database_dirty'); },
  has: () => fail('live_risk_database_dirty'),
  ownKeys: () => fail('live_risk_database_dirty'),
  getOwnPropertyDescriptor: () => fail('live_risk_database_dirty'),
  getPrototypeOf: () => fail('live_risk_database_dirty'),
});
/** A row-locking clause (FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE). */
const ROW_LOCK = /\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/i;
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
  /** `holder`: what this scope is held for, named in another's live_risk_busy. */
  constructor(private readonly pool: Pool, private readonly now = Date.now, private readonly externalFence?: Pick<SettlementClaim, 'assertFresh' | 'signal'>,
    private readonly holder: LiveRiskHolder = { kind: 'risk_scope' }) {}
  async run<T>(rawIdentity: LiveRiskIdentity, work: (scope: LiveRiskScope, session: LiveRiskDatabaseSession) => Promise<T>): Promise<T> {
    const identity = capture(rawIdentity);
    const holding = { kind: label(this.holder.kind) || 'risk_scope', id: this.holder.id === undefined ? null : label(this.holder.id), since: this.now() };
    // Match the existing transaction writer locks exactly. User limits and
    // controls are global across networks, so this lock deliberately is too.
    const accountKey = `live-risk-account:${identity.network}:${identity.accountAddress}`;
    const sourceKey = identity.source ? `live-risk-source:${identity.source.network}:${identity.source.leaderAddress}` : null;
    // `match`: the lock's pg_locks row ($1 its value); `name`: its registry key.
    const pair = (namespace: number) => `classid::bigint = ${namespace} and objid::bigint = $1::bigint and objsubid = 2`;
    const hashed = (seed: number) => `classid::bigint = ((hashtextextended($1, ${seed}) >> 32) & 4294967295) and objid::bigint = (hashtextextended($1, ${seed}) & 4294967295) and objsubid = 1`;
    const locks: { lock: LiveRiskBusyDetail['lock']; name: string; shared: boolean; match: string; acquire: string; release: string; values: (string | number)[] }[] = [
      { lock: 'policy', name: 'policy', shared: true, match: pair(7403), acquire: 'select pg_try_advisory_lock_shared(7403, 0) as locked', release: 'select pg_advisory_unlock_shared(7403, 0) as unlocked', values: [] as (string | number)[] },
      { lock: 'platform', name: 'platform', shared: true, match: pair(7405), acquire: 'select pg_try_advisory_lock_shared(7405, 0) as locked', release: 'select pg_advisory_unlock_shared(7405, 0) as unlocked', values: [] as (string | number)[] },
      { lock: 'user', name: `user:${identity.userId}`, shared: false, match: pair(7404), acquire: 'select pg_try_advisory_lock(7404, $1::integer) as locked', release: 'select pg_advisory_unlock(7404, $1::integer) as unlocked', values: [identity.userId] },
      { lock: 'account', name: accountKey, shared: false, match: hashed(7), acquire: 'select pg_try_advisory_lock(hashtextextended($1, 7)) as locked', release: 'select pg_advisory_unlock(hashtextextended($1, 7)) as unlocked', values: [accountKey] },
      ...(sourceKey ? [{ lock: 'source' as const, name: sourceKey, shared: true, match: hashed(8), acquire: 'select pg_try_advisory_lock_shared(hashtextextended($1, 8)) as locked', release: 'select pg_advisory_unlock_shared(hashtextextended($1, 8)) as unlocked', values: [sourceKey] }] : []),
    ];
    /** Who holds `lock`: this process's scopes, and the sessions pg_locks
     * shows (one read, on the refusal path only, bounded to a second). */
    const busy = async (lock: (typeof locks)[number]): Promise<never> => {
      const now = this.now(), mine = [...holders.get(lock.name) ?? []].map(h => ({ kind: h.kind, id: h.id, heldMs: Math.max(0, now - h.since) }));
      let sessions: LiveRiskBusyDetail['sessions'] = null;
      if (!lost) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const rows = await Promise.race([
            client.query<{ pid: number; application: string | null; state: string | null; held_ms: string | null; last: string | null }>(
              `select l.pid, a.application_name as application, a.state,
                 coalesce(substring(lower(a.query) from '(?:from|into|update)\\s+"?([a-z_][a-z0-9_]*)'),
                   substring(lower(a.query) from '(pg_[a-z_]*lock[a-z_]*)')) as last,
                 (extract(epoch from clock_timestamp() - coalesce(a.xact_start, a.state_change)) * 1000)::bigint as held_ms
               from pg_locks l left join pg_stat_activity a on a.pid = l.pid
               where l.locktype = 'advisory' and l.granted and l.pid <> pg_backend_pid() and ${lock.match}
                 and l.database = (select oid from pg_database where datname = current_database())
                 ${lock.shared ? "and l.mode = 'ExclusiveLock'" : ''} limit 4`,
              [lock.values[0] ?? 0]),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error()), 1000); }),
          ]);
          sessions = rows.rows.map(r => ({ pid: Number(r.pid), application: label(r.application ?? ''), state: label(r.state ?? ''), heldMs: r.held_ms === null ? null : Number(r.held_ms), last: label(r.last ?? '') }));
        } catch { sessions = null; } finally { clearTimeout(timer); }
      }
      throw new LiveRiskBusyError({ lock: lock.lock, holders: mine, sessions });
    };
    this.externalFence?.assertFresh();
    const client = this.externalFence ? await acquireSettlementConnection(this.pool, this.externalFence.signal) : await this.pool.connect();
    const acquired: typeof locks = [];
    let held = false, lost = false, checkedAt = NaN;
    let databaseBusy = false, activeOperation: Promise<unknown> | undefined;
    const onError = () => { lost = true; };
    client.on('error', onError);
    client.on('end', onError);
    // Round trips (Stage's database is ~8 ms away, and an order's evidence
    // must stay inside 5 s): this session's statements go out pipelined (each
    // with its own Sync, executed in the order sent), and every statement of
    // its DAL is followed on the wire by the lock check, so the check a
    // repository makes right after a statement is answered with it (see
    // `lockCheck`). The connection goes back to the pool as it came.
    const native = client as unknown as { pipeline: boolean; query: PoolClient['query'] };
    const pipelined = native.pipeline, ownQuery = Object.hasOwn(client, 'query'), sent = native.query;
    // Every statement sent on this connection while the scope owns it, by
    // anyone: a lock can only be released by a statement on its own session.
    let statements = 0, inflight = 0, checking = false;
    const counted = function counted(this: PoolClient, ...args: unknown[]) {
      if (!checking) statements++;
      const result = (sent as (...values: unknown[]) => unknown).apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        inflight++;
        const done = () => { inflight--; };
        (result as Promise<unknown>).then(done, done);
      }
      return result;
    } as PoolClient['query'];
    native.query = counted;
    native.pipeline = true;
    // The reuse of a lock check (`lockCheck`) rests on `statements` counting
    // every statement on this session. Everything the scope sends (the DAL's
    // statements through Drizzle, which calls only `dal.query`; the lock
    // checks; the locks' acquisition and release) calls `client.query`, never
    // the connection's protocol (`client.connection`) or a path around
    // query(); a named prepared statement is still a query() call. So
    // before each statement and at release the connection must still carry
    // `counted` (and pipeline mode): else a statement may have gone out
    // uncounted, a reused check may be stale, and the scope fails closed
    // (lost; the connection is destroyed, which releases its locks).
    const assertCounted = () => { if (native.query !== counted || native.pipeline !== true) { lost = true; fail('live_risk_serialization_lost'); } };
    /** `issuedAt` is `this.now()` (the injectable wall clock, the proof's
     * time, compared with `this.now()` only); `settledAt` is
     * `performance.now()` (monotonic, compared with `performance.now()`
     * only). The two clocks are never compared with each other. */
    interface LockCheck { readonly statements: number; readonly issuedAt: number; readonly result: Promise<boolean>; settledAt?: number }
    let lastCheck: LockCheck | undefined;
    const issueCheck = (): LockCheck => {
      assertCounted();
      const issuedAt = this.now();
      checking = true;
      let result: Promise<boolean>;
      try {
        result = Promise.resolve(client.query<{ held: boolean }>(HELD_SQL, [identity.userId, accountKey, sourceKey, locks.length]))
          .then(value => value.rows[0]?.held === true);
      } catch (error) { result = Promise.reject(error); }
      finally { checking = false; }
      const check: LockCheck = { statements, issuedAt, result };
      const settled = () => { check.settledAt = performance.now(); };
      void result.then(settled, settled);
      lastCheck = check;
      return check;
    };
    /**
     * The lock check that answers an assertHeld now: the one already sent
     * right behind the latest statement on this session, when it was sent and
     * answered (or is still pending) within LOCK_CHECK_REUSE_MS and no
     * statement was sent since; else a new one. Advisory session locks
     * change only by a statement on their own session (or its end, which
     * fails every pending query and raises `lost`), so with no statement
     * since, that check ran at the point of the session's statement order
     * where a new one would, and found what a new one would. Its own
     * (earlier) send time stays the proof's time (assertFresh's 5 s).
     */
    const lockCheck = (): LockCheck => {
      assertCounted();
      const previous = lastCheck, now = this.now();
      if (previous && previous.statements === statements && now >= previous.issuedAt && now - previous.issuedAt <= LOCK_CHECK_REUSE_MS &&
          (previous.settledAt === undefined || performance.now() - previous.settledAt <= LOCK_CHECK_REUSE_MS)) return previous;
      return issueCheck();
    };
    const assertFresh = () => {
      this.externalFence?.assertFresh();
      if (!held || lost) fail('live_risk_serialization_lost');
      const now = this.now();
      if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(checkedAt) ||
          now < checkedAt || now - checkedAt > liveEvidenceMaxAgeMs()) fail('live_risk_serialization_stale');
    };
    const scope: LiveRiskScope = Object.freeze({ identity, assertFresh, assertHeld: async () => {
      this.externalFence?.assertFresh();
      if (!held || lost) fail('live_risk_serialization_lost');
      try {
        const check = lockCheck();
        const ok = await check.result;
        if (!held || lost || ok !== true) throw new Error();
        // Timestamp is the beginning of the query, including SQL queue waits.
        checkedAt = check.issuedAt;
        assertFresh();
      } catch (error) {
        lost = true;
        if (error instanceof LiveBoundaryError) throw error;
        fail('live_risk_serialization_lost');
      }
    } });
    // The DAL's statements, each followed on the wire by the lock check. The
    // BEGIN of a scoped transaction is followed by its two transaction-local
    // timeouts (one statement), then that check; `opened` is their answers.
    // A read-only transaction's BEGIN, or a `readsFirst` one's, is not
    // waited for before its first reads go out behind it (scopedTransaction):
    // Drizzle is told it began, and the transaction awaits the real answer
    // with its first results. Until that answer only plain reads are sent,
    // so a BEGIN that failed (leaving them to run outside any transaction)
    // changed nothing. A row-locking read is not one: it writes the row's
    // lock into the tuple, and outside the transaction it would wait for a
    // contended row without the transaction's timeouts. After a failed BEGIN nothing but its ROLLBACK is sent (its
    // answer is read before any of those reads' answers, and the work only
    // sends more after one of them).
    let expectBegin: 'read' | 'reads-first' | 'write' | undefined, opened: Promise<unknown> | undefined;
    let beginPending = false, beginFailed = false;
    const dal = { query: (...args: unknown[]) => {
      try { assertCounted(); } catch (error) { return Promise.reject(error); }
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: unknown } | null)?.text;
      const begin = expectBegin !== undefined && typeof text === 'string' && /^begin\b/i.test(text) ? expectBegin : undefined;
      if (!begin) {
        if (beginFailed && !(typeof text === 'string' && /^rollback\b/i.test(text))) return Promise.reject(new LiveBoundaryError('live_risk_database_dirty'));
        if (beginPending && !(typeof text === 'string' && /^\s*select\b/i.test(text) && !ROW_LOCK.test(text))) return Promise.reject(new LiveBoundaryError('live_risk_database_dirty'));
      }
      const result = (client.query as (...values: unknown[]) => unknown)(...args);
      if (begin) {
        expectBegin = undefined;
        const answered = Promise.resolve(result);
        if (begin !== 'write') {
          beginPending = true; beginFailed = false;
          answered.then(() => { beginPending = false; }, () => { beginPending = false; beginFailed = true; });
        }
        opened = Promise.all([answered, client.query(TRANSACTION_TIMEOUTS_SQL, [holding.kind])]);
        void opened.catch(() => {});
      }
      void issueCheck().result.catch(() => {});
      return begin && begin !== 'write' ? Promise.resolve(UNANSWERED_BEGIN) : result;
    } };
    const database = drizzle(dal as unknown as PoolClient, { schema });
    const local = <R>(callback: () => Promise<R>, pipelined = false): Promise<R> => {
      try {
        assertFresh();
        if (databaseBusy) fail('live_risk_database_busy');
        if (client.getTransactionStatus() !== 'I') { lost = true; fail('live_risk_database_dirty'); }
      } catch (error) { return Promise.reject(error); }
      databaseBusy = true;
      const operation = (async () => {
        try {
          let result: R;
          if (!pipelined) {
            await scope.assertHeld();
            result = await callback();
          } else {
            // A read-only (or readsFirst) transaction goes out behind its
            // opening lock check (one round trip): the check still runs first
            // and answers first, and a lost lock still fails the work, which
            // never reaches COMMIT without its own check before it.
            const opening = scope.assertHeld();
            const [held, work] = await Promise.allSettled([opening, callback()]);
            if (held.status === 'rejected') throw held.reason;
            if (work.status === 'rejected') throw work.reason;
            result = work.value;
          }
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
    const scopedTransaction = <R>(callback: (tx: DbTransaction) => Promise<R>, readOnly = false, readsFirst = false) => local(async () => {
      expectBegin = readOnly ? 'read' : readsFirst ? 'reads-first' : 'write'; opened = undefined; beginPending = false; beginFailed = false;
      try {
        return await database.transaction(async tx => {
          // BEGIN and the SET LOCAL of both timeouts sent right behind it.
          const begun = opened; opened = undefined;
          if (!begun) fail('live_risk_database_dirty');
          let result: R;
          if (!readOnly && !readsFirst) {
            await begun;
            await scope.assertHeld();
            result = await callback(tx);
          } else {
            // Its first reads go out behind BEGIN, the timeouts and the lock
            // check, executed after them; all three answers are required
            // before its result, and before COMMIT (below) as ever.
            const held = scope.assertHeld();
            const [opening, work] = await Promise.allSettled([Promise.all([begun, held]), callback(tx)]);
            if (opening.status === 'rejected') throw opening.reason;
            if (work.status === 'rejected') throw work.reason;
            result = work.value;
          }
          // A released/ended original scope must roll back before COMMIT.
          await scope.assertHeld();
          return result;
        }, readOnly ? { isolationLevel: 'repeatable read', accessMode: 'read only' } : undefined);
      } finally { expectBegin = undefined; opened = undefined; beginPending = false; beginFailed = false; }
    }, readOnly || readsFirst);
    const session: LiveRiskDatabaseSession = Object.freeze({ scope,
      read: <R>(callback: (db: DbExecutor) => Promise<R>) => scopedTransaction(callback, true),
      transaction: <R>(callback: (tx: DbTransaction) => Promise<R>, options?: { readonly readsFirst?: boolean }) => scopedTransaction(callback, false, options?.readsFirst === true),
    });
    try {
      // Never adopt or commit another caller's unfinished SQL transaction.
      if (client.getTransactionStatus() !== 'I') { lost = true; fail('live_risk_database_dirty'); }
      // Stable policy -> platform -> user -> account order. Try rather than wait: no provider budget
      // or prepared order can be consumed by a concurrent owner of this scope.
      holding.since = this.now();
      for (const lock of locks) {
        this.externalFence?.assertFresh();
        assertCounted();
        let result = await client.query<{ locked: boolean }>(lock.acquire, lock.values);
        this.externalFence?.assertFresh();
        if (lost) fail('live_risk_busy');
        // An exclusive lock another scope holds for a few hundred ms (an order,
        // a settlement) is tried again for LIVE_RISK_LOCK_WAIT_MS before
        // live_risk_busy: still a try, nothing read or reserved meanwhile.
        for (const until = performance.now() + LIVE_RISK_LOCK_WAIT_MS; result.rows[0]?.locked !== true && !lock.shared && performance.now() + LIVE_RISK_LOCK_POLL_MS <= until;) {
          await sleep(LIVE_RISK_LOCK_POLL_MS, undefined, this.externalFence ? { signal: this.externalFence.signal } : undefined);
          this.externalFence?.assertFresh();
          assertCounted();
          result = await client.query<{ locked: boolean }>(lock.acquire, lock.values);
          this.externalFence?.assertFresh();
          if (lost) fail('live_risk_busy');
        }
        if (result.rows[0]?.locked !== true) await busy(lock);
        acquired.push(lock);
        let named = holders.get(lock.name);
        if (!named) holders.set(lock.name, named = new Set());
        named.add(holding);
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
      for (const lock of acquired) {
        const named = holders.get(lock.name);
        named?.delete(holding);
        if (named?.size === 0) holders.delete(lock.name);
      }
      let discard = lost || client.getTransactionStatus() !== 'I';
      if (this.externalFence) { try { this.externalFence.assertFresh(); } catch { discard = true; } }
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
      // Not released by statements sent around the counted query: destroyed.
      if (native.query !== counted || native.pipeline !== true) discard = true;
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
      // Back to the pool exactly as it came (its query method and protocol
      // mode), with nothing of this scope still on the wire.
      if (inflight !== 0 || native.query !== counted || native.pipeline !== true) discard = true;
      if (ownQuery) native.query = sent; else delete (client as { query?: unknown }).query;
      native.pipeline = pipelined;
      client.release(discard || client.getTransactionStatus() !== 'I');
    }
  }
}
