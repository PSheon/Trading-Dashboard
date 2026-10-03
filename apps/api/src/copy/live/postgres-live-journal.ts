import type { LiveExecutionLease } from "./live-execution-gate.js";
import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { copyLiveExecutions, copySignerNonces } from "@trading-dashboard/shared/database";
import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import { DATABASE_POOL, type DrizzleDb } from "../../db/drizzle.provider.js";
import { UnitOfWork } from "../../db/unit-of-work.js";
import { type LiveExecutionJournal, type LiveExecutionRecord } from "./live-execution.js";
import { LiveBoundaryError, address } from "./wallet-authorization.js";
import { marketIdentityKey } from './live-market-resolver.js';

type ExecutionRow = typeof copyLiveExecutions.$inferSelect;
export const liveExecutionTransitions: Record<LiveExecutionRecord["state"], readonly LiveExecutionRecord["state"][]> = {
  prepared: ["submitting", "rejected"], submitting: ["unknown", "resting", "filled", "partial", "cancelled", "rejected"],
  unknown: ["unknown", "resting", "filled", "partial", "cancelled", "rejected"],
  resting: ["resting", "filled", "partial", "cancelled", "rejected"], filled: [], partial: [], cancelled: [], rejected: [],
};
export function decodeLiveExecutionRow(row: ExecutionRow): LiveExecutionRecord {
  const record = row.record as unknown as LiveExecutionRecord;
  if (record?.market) {
    marketIdentityKey(record.market);
    if (record.market.network !== row.network || record.market.asset !== record.action?.orders?.[0]?.a)
      throw new LiveBoundaryError('execution_record_market_mismatch');
  }
  if (!record || typeof record !== "object" || !record.authorization || !record.action?.orders?.[0] ||
      record.key !== row.key || record.nonce !== row.nonce || record.state !== row.state ||
      !Number.isSafeInteger(record.nonce) || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt) ||
      !Number.isSafeInteger(record.expiresAfter) || !(record.state in liveExecutionTransitions) || typeof record.fingerprint !== "string" ||
      record.authorization.network !== row.network || address(record.authorization.accountAddress) !== row.accountAddress ||
      address(record.authorization.signerAddress) !== row.signerAddress || record.authorization.userId !== row.userId ||
      record.authorization.strategyId !== row.strategyId || record.action.orders[0].c !== row.cloid ||
      row.key !== `${row.network}:${row.accountAddress}:${row.cloid}` || record.updatedAt !== row.updatedAt.getTime() ||
      (record.outcome && record.outcome.state !== record.state)) throw new LiveBoundaryError("execution_record_invalid");
  return record;
}
export function immutableLiveExecution(record: LiveExecutionRecord) {
  return { key: record.key, fingerprint: record.fingerprint, authorization: record.authorization, action: record.action,
    nonce: record.nonce, expiresAfter: record.expiresAfter, createdAt: record.createdAt, ...(record.market ? { market: record.market } : {}) };
}

@Injectable()
export class PostgresLiveExecutionJournal implements LiveExecutionJournal {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, @Inject(DATABASE_POOL) private readonly pool: Pool, private readonly uow: UnitOfWork) {}

  async withOrderLock<T>(key: string, work: (lease: LiveExecutionLease) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    let lost = false;
    const onError = () => { lost = true; };
    client.on("error", onError);
    client.on("end", onError);
    const lease: LiveExecutionLease = { assertHeld: async () => {
      if (!locked || lost) throw new LiveBoundaryError("execution_lease_lost");
      try {
        const result = await client.query<{ held: boolean }>(`
          select exists(select 1 from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'
            and granted and mode = 'ExclusiveLock' and objsubid = 1
            and classid::bigint = ((hashtextextended($1, 1) >> 32) & 4294967295)
            and objid::bigint = (hashtextextended($1, 1) & 4294967295)) as held`, [`live-order:${key}`]);
        if (result.rows[0]?.held !== true || lost) throw new Error("lost");
      } catch { lost = true; throw new LiveBoundaryError("execution_lease_lost"); }
    } };
    try {
      const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 1)) as locked", [`live-order:${key}`]);
      locked = result.rows[0]?.locked === true;
      if (!locked) throw new LiveBoundaryError("execution_busy");
      return await work(lease);
    } finally {
      let discard = lost;
      if (locked) {
        try { await client.query("select pg_advisory_unlock(hashtextextended($1, 1))", [`live-order:${key}`]); }
        catch { discard = true; }
      }
      locked = false;
      client.removeListener("error", onError);
      client.removeListener("end", onError);
      client.release(discard);
    }
  }

  async get(key: string): Promise<LiveExecutionRecord | null> {
    const [row] = await this.db.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
    if (!row) return null;
    return decodeLiveExecutionRow(row);
  }

  async prepare(input: Parameters<LiveExecutionJournal["prepare"]>[0]): Promise<LiveExecutionRecord> {
    const { authorization: grant, now, key, fingerprint, action, market } = input;
    if (market && (marketIdentityKey(market).network !== grant.network || market.asset !== action.orders[0].a))
      throw new LiveBoundaryError('execution_record_market_mismatch');
    if (!Number.isSafeInteger(now) || now < 0 || key !== `${grant.network}:${address(grant.accountAddress)}:${action.orders[0].c}`) throw new LiveBoundaryError("execution_record_invalid");
    return this.uow.run(async (tx) => {
      const signer = address(grant.signerAddress);
      // Distinct lock namespace from the session execution lock: its holder uses
      // another DB connection. Also serialize cloid preparation across signer rotation.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`live-prepare:${key}`}, 3))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`live-nonce:${grant.network}:${signer}`}, 2))`);
      const [existing] = await tx.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key));
      if (existing) {
        const record = decodeLiveExecutionRow(existing);
        if (record.fingerprint !== fingerprint) throw new LiveBoundaryError("cloid_payload_conflict");
        if (!isDeepStrictEqual(record.action, action)) throw new LiveBoundaryError("persisted_order_payload_mismatch");
        if (!isDeepStrictEqual(record.market ? marketIdentityKey(record.market) : undefined, market ? marketIdentityKey(market) : undefined))
          throw new LiveBoundaryError('persisted_order_market_mismatch');
        return record;
      }
      const allocated = await tx.execute(sql`
        insert into ${copySignerNonces} (network, signer_address, nonce) values (${grant.network}, ${signer}, ${now})
        on conflict (network, signer_address) do update set nonce = greatest(${now}, ${copySignerNonces}.nonce + 1)
        returning nonce
      `);
      const nonce = Number(allocated.rows[0]?.nonce);
      if (!Number.isSafeInteger(nonce) || nonce > now + 30_000) throw new LiveBoundaryError("nonce_clock_skew");
      const record: LiveExecutionRecord = { key, fingerprint, authorization: grant, action, ...(market ? { market: structuredClone(market) } : {}), nonce, expiresAfter: now + 60_000, state: "prepared", createdAt: now, updatedAt: now };
      await tx.insert(copyLiveExecutions).values({ key, network: grant.network, accountAddress: address(grant.accountAddress), signerAddress: signer,
        cloid: action.orders[0].c, nonce, userId: grant.userId, strategyId: grant.strategyId, state: record.state, record: record as unknown as Record<string, unknown>, updatedAt: new Date(now) });
      return record;
    });
  }

  async save(record: LiveExecutionRecord): Promise<void> {
    await this.uow.run(async (tx) => {
      const [row] = await tx.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, record.key)).for("update");
      if (!row) throw new LiveBoundaryError("execution_record_missing");
      const existing = decodeLiveExecutionRow(row);
      if (!isDeepStrictEqual(immutableLiveExecution(existing), immutableLiveExecution(record))) throw new LiveBoundaryError("execution_record_immutable");
      if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < existing.updatedAt ||
          (record.outcome && record.outcome.state !== record.state)) throw new LiveBoundaryError("execution_record_invalid");
      // JSONB omits undefined optional properties. Preserve idempotent persistence retries.
      if (isDeepStrictEqual(existing, JSON.parse(JSON.stringify(record)))) return;
      if (!liveExecutionTransitions[existing.state].includes(record.state)) throw new LiveBoundaryError("execution_state_transition_denied");
      await tx.update(copyLiveExecutions).set({ state: record.state, record: record as unknown as Record<string, unknown>, updatedAt: new Date(record.updatedAt) })
        .where(eq(copyLiveExecutions.key, record.key));
    });
  }
}
