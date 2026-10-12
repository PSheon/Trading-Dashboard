import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { and, eq, ne, notInArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@trading-dashboard/shared/database';
import { copyLiveExecutions, copyLiveIntentProvenance, copyLiveMandates, copyLiveReductionCarry, copyLiveRiskReservations, copyLiveSignalLegs,
  copyLiveSourceFills } from '@trading-dashboard/shared/database';
import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { DrizzleDb } from '../../db/drizzle.provider.js';
import type { DbExecutor } from '../../db/unit-of-work.js';
import { PostgresLiveRiskScope } from '../live/postgres-live-risk-scope.js';
import { LiveBoundaryError } from '../live/wallet-authorization.js';

/** A coin's reduction carry with something owed, as read before the
 * observation that proves the follower flat in that coin. */
export interface OwedCarry { readonly mandateId: string; readonly revision: number; readonly carry: string; readonly updatedAt: Date }
type CloseRow = { readonly userId: number; readonly accountId: string; readonly strategyId: number; readonly coin: string };
class Deferred extends Error {}

/**
 * A single-position close (the owner's, or one after the leader went flat)
 * that left the follower flat in a coin: what earlier settled closes still
 * owed of it (copy_live_reduction_carry) is owed of nothing. Kept, a later
 * re-open of size N had its partial close sized carry + f·(N − carry), or
 * refused when N < carry, instead of f·N.
 *
 * The reset is a carry change like a settled close's: revision + 1, never an
 * earlier updated_at (the "carry is never rewound" rule). It is made only when
 * nothing still relies on the carry it replaces, all in one transaction under
 * the account's original risk locks (user and account, as settlement):
 * - the carry row is locked FOR UPDATE and still the one read before the flat
 *   observation (no close settled since: its carry belongs to the position
 *   that observation saw closed);
 * - no journal of that generation and coin is prepared, submitting, unknown or
 *   resting, and no reservation of it is unreleased: their sizing basis names
 *   this carry, which settlement (live_settlement_carry_changed), the risk
 *   gate and an unattempted release (originalCarry) require unchanged.
 * Otherwise it waits for a later pass (the close stays requested).
 */
export class CopyLiveFlatCarry {
  private readonly db: DrizzleDb;
  constructor(private readonly network: HyperliquidNetwork, private readonly pool: Pool, private readonly now: () => number = Date.now) {
    this.db = drizzle(pool, { schema });
  }
  private rows(db: DbExecutor, row: CloseRow) {
    return db.select({ mandateId: copyLiveReductionCarry.mandateId, revision: copyLiveReductionCarry.revision, carry: copyLiveReductionCarry.carry, updatedAt: copyLiveReductionCarry.updatedAt })
      .from(copyLiveReductionCarry).innerJoin(copyLiveMandates, eq(copyLiveMandates.id, copyLiveReductionCarry.mandateId))
      .where(and(eq(copyLiveMandates.accountId, row.accountId), eq(copyLiveMandates.userId, row.userId), eq(copyLiveMandates.strategyId, row.strategyId),
        eq(copyLiveMandates.network, this.network), notInArray(copyLiveMandates.state, ['stopped', 'revoked', 'expired']),
        eq(copyLiveReductionCarry.coin, row.coin), ne(copyLiveReductionCarry.carry, '0')))
      .orderBy(copyLiveReductionCarry.mandateId);
  }
  /** Read before observing the account: what is owed of `row.coin` now. */
  async owed(row: CloseRow): Promise<OwedCarry[]> {
    return this.rows(this.db, row);
  }
  /** After the account was observed flat in `row.coin`: resets what `owed`
   * read to 0. False when it must wait for a later pass. */
  async reset(row: CloseRow, accountAddress: string, owed: readonly OwedCarry[]): Promise<boolean> {
    if (!owed.length) return true;
    try {
      return await new PostgresLiveRiskScope(this.pool, this.now).run({ userId: row.userId, network: this.network, accountAddress }, async (scope, session) => session.transaction(async tx => {
        const current = await this.rows(tx, row).for('update', { of: copyLiveReductionCarry }); await scope.assertHeld();
        if (!isDeepStrictEqual(current, [...owed])) throw new Deferred();
        for (const c of current) {
          const at = new Date(Math.max(this.now(), c.updatedAt.getTime()));
          const changed = await tx.update(copyLiveReductionCarry).set({ carry: '0', revision: c.revision + 1, updatedAt: at })
            .where(and(eq(copyLiveReductionCarry.mandateId, c.mandateId), eq(copyLiveReductionCarry.coin, row.coin), eq(copyLiveReductionCarry.revision, c.revision),
              eq(copyLiveReductionCarry.carry, c.carry),
              sql`not exists (select 1 from ${copyLiveIntentProvenance} p join ${copyLiveExecutions} e on e.key = p.key
                join ${copyLiveSignalLegs} l on l.id = p.leg_id join ${copyLiveSourceFills} f on f.id = l.source_fill_id
                where p.mandate_id = ${c.mandateId} and f.coin = ${row.coin} and e.state in ('prepared', 'submitting', 'unknown', 'resting'))`,
              sql`not exists (select 1 from ${copyLiveIntentProvenance} p join ${copyLiveRiskReservations} r on r.key = p.key
                where p.mandate_id = ${c.mandateId} and r.coin = ${row.coin} and r.state <> 'released')`))
            .returning({ mandateId: copyLiveReductionCarry.mandateId });
          await scope.assertHeld();
          if (changed.length !== 1) throw new Deferred();
        }
        return true;
      }));
    } catch (error) {
      // An order or settlement of the account holds its locks right now.
      if (error instanceof Deferred || error instanceof LiveBoundaryError && error.code === 'live_risk_busy') return false;
      throw error;
    }
  }
}
