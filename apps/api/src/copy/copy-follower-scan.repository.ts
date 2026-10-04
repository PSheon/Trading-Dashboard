import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { copyExecutionAccounts, copyFollowerScans } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { FollowerReceiptWindow, FollowerWindowObservation } from "./live/follower-receipt-reader.js";
import { LiveBoundaryError } from "./live/wallet-authorization.js";

export type ScanState = { from: number; to: number; pending: FollowerReceiptWindow[]; historicalCompleteness: "unproven"; observations: readonly FollowerWindowObservation[] };
export type ScanClaim = typeof copyFollowerScans.$inferSelect & { address: string; accountCreatedAt: Date };

@Injectable()
export class CopyFollowerScanRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  claim(): Promise<ScanClaim | null> {
    return this.db.transaction(async tx => {
      // Global database admission also spans worker replicas. Reserve at most
      // one 240-weight pass per minute rather than one per process/account.
      const lock = await tx.execute<{ held: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext('copy-follower-scan-budget:testnet')) as held`);
      if (!lock.rows[0]?.held) return null;
      const recent = await tx.select({ id: copyFollowerScans.accountId }).from(copyFollowerScans)
        .where(and(isNotNull(copyFollowerScans.claimToken), sql`${copyFollowerScans.nextRunAt} > clock_timestamp() + interval '60 seconds'`)).limit(1);
      if (recent.length) return null;
      // Never filter by owner enabled, strategy active or agent grant: late
      // receipts are still real money after stop/revocation.
      await tx.execute(sql`insert into copy_follower_scans (account_id)
        select id from copy_execution_accounts where network = 'testnet' and address is not null
        on conflict (account_id) do nothing`);
      const [row] = await tx.select({ scan: copyFollowerScans, address: copyExecutionAccounts.address, accountCreatedAt: copyExecutionAccounts.createdAt })
        .from(copyFollowerScans).innerJoin(copyExecutionAccounts, eq(copyFollowerScans.accountId, copyExecutionAccounts.id))
        .where(and(eq(copyExecutionAccounts.network, "testnet"), isNotNull(copyExecutionAccounts.address), sql`${copyFollowerScans.nextRunAt} <= clock_timestamp()`))
        .orderBy(copyFollowerScans.nextRunAt, copyFollowerScans.accountId).limit(1).for("update", { of: copyFollowerScans, skipLocked: true });
      if (!row?.address) return null;
      const [claimed] = await tx.update(copyFollowerScans).set({ claimToken: randomUUID(), nextRunAt: sql`clock_timestamp() + interval '120 seconds'`, updatedAt: sql`clock_timestamp()` })
        .where(eq(copyFollowerScans.accountId, row.scan.accountId)).returning();
      return { ...claimed, address: row.address, accountCreatedAt: row.accountCreatedAt };
    });
  }
  /** Claims one testnet account's scan regardless of its schedule. A pass
   * already holding it loses its claim token, so its save is ignored. */
  claimAccount(accountId: string): Promise<ScanClaim | null> {
    return this.db.transaction(async tx => {
      const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.network, "testnet"), isNotNull(copyExecutionAccounts.address)));
      if (!account?.address) return null;
      await tx.insert(copyFollowerScans).values({ accountId }).onConflictDoNothing();
      const [claimed] = await tx.update(copyFollowerScans).set({ claimToken: randomUUID(), nextRunAt: sql`clock_timestamp() + interval '120 seconds'`, updatedAt: sql`clock_timestamp()` })
        .where(eq(copyFollowerScans.accountId, accountId)).returning();
      return claimed ? { ...claimed, address: account.address, accountCreatedAt: account.createdAt } : null;
    });
  }
  async save(claim: ScanClaim, scanState: ScanState, through: number | null) {
    return this.db.transaction(async tx => {
      const [account] = await tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, claim.accountId)).for("share");
      if (!account || account.network !== "testnet" || account.address !== claim.address) throw new LiveBoundaryError("follower_account_identity_changed");
      const rows = await tx.update(copyFollowerScans).set({ scanState, through, issue: null, updatedAt: new Date() })
        .where(and(eq(copyFollowerScans.accountId, claim.accountId), eq(copyFollowerScans.claimToken, claim.claimToken!))).returning({ id: copyFollowerScans.accountId });
      return rows.length === 1;
    });
  }
  async issue(claim: ScanClaim, issue: string) {
    await this.db.update(copyFollowerScans).set({ issue, updatedAt: new Date() })
      .where(and(eq(copyFollowerScans.accountId, claim.accountId), eq(copyFollowerScans.claimToken, claim.claimToken!)));
  }
}
