import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { copySignalOutbox, copyStrategies, fills } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import type { DbTransaction } from "../db/unit-of-work.js";

/** Advisory-lock namespace of a copied leader address (fills enqueue vs. strategy activation). */
const COPY_LEADER_LOCK_NAMESPACE = 7402;

/** Serializes "store a leader's fills and enqueue them" with "start copying
 * that leader and catch up from stored fills", so neither can miss a fill
 * the other committed. Held for DB statements only. */
export async function lockCopyLeader(tx: DbTransaction, address: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(COPY_LEADER_LOCK_NAMESPACE))}, hashtext(${address}))`);
}

/** Live strategy statuses: their leader's fills are copy signals. */
export const LIVE_STRATEGY_STATUSES = ["active", "paused", "stopping"] as const;

/**
 * Execution outbox write, in the same transaction as the fills insert: each
 * newly stored fill of an address that somebody copies, at or after the
 * earliest activation cursor, becomes one pending row. Idempotent on
 * (chain, address, tid). Caller holds {@link lockCopyLeader}.
 */
export async function enqueueCopySignals(tx: DbTransaction, address: string, inserted: { tid: bigint; ts: Date }[]): Promise<number> {
  if (inserted.length === 0) return 0;
  const [cursor] = await tx
    .select({ from: sql<Date | null>`min(${copyStrategies.activatedAt})` })
    .from(copyStrategies)
    .where(and(eq(copyStrategies.mode, "paper"), eq(copyStrategies.chain, CHAIN_DEFAULT), eq(copyStrategies.leaderAddress, address), inArray(copyStrategies.status, [...LIVE_STRATEGY_STATUSES])));
  if (!cursor?.from) return 0;
  const from = new Date(cursor.from).getTime();
  const rows = inserted.filter((r) => r.ts.getTime() > from).map((r) => ({ chain: CHAIN_DEFAULT, address, tid: r.tid, fillTime: r.ts }));
  if (rows.length === 0) return 0;
  const out = await tx.insert(copySignalOutbox).values(rows).onConflictDoNothing().returning({ id: copySignalOutbox.id });
  return out.length;
}

/** On activation: enqueue this leader's already-stored fills after the
 * cursor (a fill stored between the leader snapshot and the commit). */
export async function catchUpCopySignals(tx: DbTransaction, address: string, after: Date): Promise<number> {
  const rows = await tx
    .select({ tid: fills.tid, ts: fills.ts })
    .from(fills)
    .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), gt(fills.ts, after),
      sql`exists (select 1 from ${copyStrategies} where ${copyStrategies.mode} = 'paper' and ${copyStrategies.chain} = ${CHAIN_DEFAULT}
        and ${copyStrategies.leaderAddress} = ${address} and ${inArray(copyStrategies.status, [...LIVE_STRATEGY_STATUSES])})`));
  if (rows.length === 0) return 0;
  const out = await tx
    .insert(copySignalOutbox)
    .values(rows.map((r) => ({ chain: CHAIN_DEFAULT, address, tid: r.tid, fillTime: r.ts })))
    .onConflictDoNothing()
    .returning({ id: copySignalOutbox.id });
  return out.length;
}
