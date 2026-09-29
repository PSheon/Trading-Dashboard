import type { EventEmitter2 } from "@nestjs/event-emitter";
import { and, eq, gte, sql } from "drizzle-orm";
import { actions, actionOutbox, fills } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import type { ActionDraft } from "./action-classifier.js";
import { ACTION_CREATED_EVENT } from "./action-created.event.js";

/** Shared by the feed fast path (`FeedActionsService`) and fill storage
 * (`FillSyncService`), which both write `actions` for the same trades. */

export type ActionRow = typeof actions.$inferSelect;
type Tx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];
export type DbOrTx = DrizzleDb | Tx;

/** Postgres caps one statement at 65,535 bind parameters (a fills row has
 * 13, an actions row 10); a high-frequency address can produce thousands of
 * rows in one sync, so inserts go in chunks. */
const INSERT_CHUNK_ROWS = 1000;

export function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) out.push(rows.slice(i, i + INSERT_CHUNK_ROWS));
  return out;
}

/** A bigint[] as one bind parameter (Postgres array literal). */
function bigintArray(values: Iterable<bigint>) {
  return sql`${`{${[...values].join(",")}}`}::bigint[]`;
}

/** Arbitrary namespace for this module's advisory locks. */
const ACTIONS_LOCK_NAMESPACE = 7401;

/**
 * Runs `fn` in a transaction holding the address's action lock. The fast
 * path and fill storage both check which trades already have an action and
 * then insert the rest; the lock keeps the two from both inserting one. It
 * is held only for these DB statements, never across an HTTP call.
 */
export function withActionLock<T>(db: DrizzleDb, address: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(ACTIONS_LOCK_NAMESPACE))}, hashtext(${address}))`);
    return fn(tx);
  });
}

/** This address's actions that include any of `tids`. An action's `ts` is
 * its last fill's time, so none older than the oldest fill can match. */
export async function actionsCovering(db: DbOrTx, address: string, tids: bigint[], minTime: number): Promise<ActionRow[]> {
  if (tids.length === 0) return [];
  return db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.chain, CHAIN_DEFAULT),
        eq(actions.address, address),
        gte(actions.ts, new Date(minTime)),
        sql`${actions.fillIds} && ${bigintArray(tids)}`,
      ),
    );
}

/** Stored fills of this address among `tids`, as Hyperliquid returned them. */
export async function storedFills(db: DbOrTx, address: string, tids: bigint[]): Promise<HlUserFill[]> {
  if (tids.length === 0) return [];
  const rows = await db
    .select({ raw: fills.raw })
    .from(fills)
    .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), sql`${fills.tid} = any(${bigintArray(tids)})`));
  return rows.map((r) => r.raw as unknown as HlUserFill);
}

export function draftToRow(address: string, d: ActionDraft) {
  return {
    chain: CHAIN_DEFAULT,
    address,
    coin: d.coin,
    kind: d.kind,
    side: d.side,
    notionalUsd: d.notionalUsd,
    avgPx: d.avgPx,
    leverage: d.leverage,
    fillIds: d.fillIds,
    ts: d.ts,
  };
}

export async function insertActions(db: DbOrTx, address: string, drafts: ActionDraft[], enqueue = false, equityUsd: number | null = null, maxActionAgeSeconds = 120): Promise<ActionRow[]> {
  const rows: ActionRow[] = [];
  for (const chunk of chunks(drafts)) {
    rows.push(...(await db.insert(actions).values(chunk.map((d) => draftToRow(address, d))).returning()));
  }
  if (enqueue) {
    const horizon = Date.now() - maxActionAgeSeconds * 1000;
    const recent = rows.filter((row) => row.ts.getTime() >= horizon);
    if (recent.length) await db.insert(actionOutbox).values(recent.map((row) => ({ actionId: row.id, equityUsd: equityUsd !== null && Number.isFinite(equityUsd) ? String(equityUsd) : null }))).onConflictDoNothing();
  }
  return rows;
}

/** Emits `action.created` for rows within the alert horizon. Anything older
 * is stored for analytics but never alerted on: a notification about a
 * trade from an hour ago would read as if it just happened. */
export function emitRecent(events: EventEmitter2 | undefined, rows: ActionRow[], maxActionAgeSeconds = 120): void {
  const horizon = Date.now() - maxActionAgeSeconds * 1000;
  for (const row of rows) {
    if (row.ts.getTime() >= horizon) events?.emit(ACTION_CREATED_EVENT, row);
  }
}
