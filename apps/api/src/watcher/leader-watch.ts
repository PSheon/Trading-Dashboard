import { and, eq, inArray, sql } from "drizzle-orm";
import { copyStrategies, leaders, userFavorites } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import type { DbTransaction } from "../db/unit-of-work.js";

/** Leader rows a user's action created (a favorite, a copy). Their `active`
 * flag is managed here, whichever of the two created the row: an address
 * is watched while anyone favorites or copies it. Imported rows belong to
 * the admin (A3) and are never switched by a user's action. */
const USER_SOURCES = ["favorite", "copy"] as const;

/**
 * Makes sure `address` is watched because someone favorited or copies it,
 * in the caller's transaction. A new row gets `source`; an existing
 * user-sourced row that had been switched off is switched on again, by
 * either path (a copy-sourced row whose last copy stopped is watched again
 * when someone favorites it, and the other way round). Returns true when
 * the row was created.
 */
export async function watchLeader(tx: DbTransaction, address: string, source: (typeof USER_SOURCES)[number]): Promise<boolean> {
  const inserted = await tx.insert(leaders).values({ chain: CHAIN_DEFAULT, address, active: true, source })
    .onConflictDoNothing({ target: [leaders.chain, leaders.address] }).returning({ address: leaders.address });
  if (inserted.length) return true;
  // Locked first: an unwatch of the same address that is still in flight
  // is waited for, instead of this update not seeing the row it switches off.
  await tx.select({ address: leaders.address }).from(leaders).where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.address, address))).for("update");
  await tx.update(leaders).set({ active: true })
    .where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.address, address), inArray(leaders.source, [...USER_SOURCES]), eq(leaders.active, false)));
  return false;
}

/**
 * Stops watching a user-sourced leader that nobody favorites and nobody
 * copies any more (a copy counts until it is `stopped`: its fills are copy
 * signals). Called after a favorite was removed and after a copy settled.
 * The leader row is locked first, so a concurrent favorite or copy of the
 * same address is seen or waits.
 */
export async function unwatchLeaderIfUnused(tx: DbTransaction, address: string): Promise<void> {
  const chain = CHAIN_DEFAULT;
  await tx.select({ address: leaders.address }).from(leaders).where(and(eq(leaders.chain, chain), eq(leaders.address, address))).for("update");
  await tx.update(leaders).set({ active: false }).where(and(eq(leaders.chain, chain), eq(leaders.address, address), inArray(leaders.source, [...USER_SOURCES]),
    sql`not exists (select 1 from ${userFavorites} where ${userFavorites.chain} = ${chain} and ${userFavorites.address} = ${address})`,
    sql`not exists (select 1 from ${copyStrategies} where ${copyStrategies.chain} = ${chain} and ${copyStrategies.leaderAddress} = ${address} and ${copyStrategies.status} <> 'stopped')`));
}
