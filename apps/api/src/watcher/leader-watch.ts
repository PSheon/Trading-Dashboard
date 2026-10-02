import { and, count, eq, inArray, sql } from "drizzle-orm";
import { copyStrategies, leaders, userFavorites } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import type { DbTransaction } from "../db/unit-of-work.js";

/** Leader rows a user's action created (a favorite, a copy). Their `active`
 * flag is managed here, whichever of the two created the row: an address
 * is watched while anyone favorites or copies it. Imported rows belong to
 * the admin (A3) and are never switched by a user's action. */
const USER_SOURCES = ["favorite", "copy"] as const;

/** The site-wide cap on user-watched addresses is reached and `address` is
 * not watched yet (`general.maxWatchedAddresses`). */
export class WatchCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`The site already watches ${limit} addresses for its users`);
    this.name = "WatchCapacityError";
  }
}

/** One at a time through the capacity check, so two additions can't both
 * take the last place. Held to the end of the caller's transaction. */
const WATCH_CAPACITY_LOCK = 4_203_401;

/**
 * Makes sure `address` is watched because someone favorited or copies it,
 * in the caller's transaction. A new row gets `source`; an existing
 * user-sourced row that had been switched off is switched on again, by
 * either path (a copy-sourced row whose last copy stopped is watched again
 * when someone favorites it, and the other way round). Returns true when
 * the row was created.
 *
 * `limit` (`general.maxWatchedAddresses`): when watching `address` would
 * add one to the user-watched addresses and that many are already active,
 * throws {@link WatchCapacityError} and changes nothing. An address that is
 * already watched (by anyone, or as an imported leader) always passes.
 */
export async function watchLeader(tx: DbTransaction, address: string, source: (typeof USER_SOURCES)[number], limit?: number): Promise<boolean> {
  if (limit !== undefined) {
    await tx.execute(sql`select pg_advisory_xact_lock(${WATCH_CAPACITY_LOCK})`);
    const [existing] = await tx.select({ active: leaders.active, source: leaders.source }).from(leaders).where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.address, address)));
    const adds = !existing || (!existing.active && (USER_SOURCES as readonly string[]).includes(existing.source));
    if (adds) {
      const [{ n }] = await tx.select({ n: count() }).from(leaders).where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.active, true), inArray(leaders.source, [...USER_SOURCES])));
      if (n >= limit) throw new WatchCapacityError(limit);
    }
  }
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
