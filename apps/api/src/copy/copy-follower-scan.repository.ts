import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { copyExecutionAccounts, copyFollowerScans, copyFollowerObservationBudget } from "@trading-dashboard/shared/database";
import { AppConfig } from "../config/app-config.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import { deploymentNetwork } from "./live-deployment.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { FollowerReceiptWindow, FollowerWindowObservation } from "./live/follower-receipt-reader.js";
import { LiveBoundaryError } from "./live/wallet-authorization.js";
import type { HyperliquidNetwork } from "@trading-dashboard/shared/contracts";
import { followerForegroundReadEligible, followerFreshForeground, followerRecoveryAccount } from './copy-foreground-read-priority.js';

export type ScanState = { from: number; to: number; pending: FollowerReceiptWindow[]; historicalCompleteness: "unproven"; observations: readonly FollowerWindowObservation[] };
export type ScanClaim = typeof copyFollowerScans.$inferSelect & { address: string; accountCreatedAt: Date; network: HyperliquidNetwork };

/** Receipt scans of the deployment's network's copy accounts only. */
@Injectable()
export class CopyFollowerScanRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig) {}
  private get network() { return deploymentNetwork(this.config); }
  claim(): Promise<ScanClaim | null> {
    const network = this.network;
    return this.db.transaction(async tx => {
      // Global database admission also spans worker replicas. Reserve at most
      // one 240-weight pass per minute rather than one per process/account.
      const lock = await tx.execute<{ held: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${`copy-follower-scan-budget:${network}`})) as held`);
      if (!lock.rows[0]?.held) return null;
      const recent = await tx.select({ id: copyFollowerScans.accountId }).from(copyFollowerScans)
        .where(and(isNotNull(copyFollowerScans.claimToken), sql`${copyFollowerScans.nextRunAt} > clock_timestamp() + interval '60 seconds'`)).limit(1);
      if (recent.length) return null;
      let freshForeground = false, allowRetainedFairness = false;
      if (network === 'testnet') {
        const busy = await tx.execute<{ busy: boolean }>(sql`select ${followerFreshForeground} as busy`);
        freshForeground = busy.rows[0]?.busy === true;
        if (freshForeground) {
          await tx.insert(copyFollowerObservationBudget).values({ network, nextAllowedAt: sql`clock_timestamp()` }).onConflictDoNothing();
          // A separate persisted marker prevents scans and reporting from
          // consuming each other's five-minute busy-period fairness. Its first
          // deferral is initialized once; foreground runFor never renews it.
          const [fairness] = await tx.update(copyFollowerObservationBudget)
            .set({ nextReceiptAllowedAt: sql`coalesce(${copyFollowerObservationBudget.nextReceiptAllowedAt}, clock_timestamp() + interval '300 seconds')` })
            .where(eq(copyFollowerObservationBudget.network, network))
            .returning({ available: sql<boolean>`${copyFollowerObservationBudget.nextReceiptAllowedAt} <= clock_timestamp()` });
          allowRetainedFairness = fairness?.available === true;
        }
      }
      // Avoid a second paid receipt pass beside live settlement. Recovery
      // accounts remain admitted; a stale fill cannot starve ordinary scans.
      const eligible = await tx.select({ id: copyExecutionAccounts.id }).from(copyExecutionAccounts)
        .where(and(eq(copyExecutionAccounts.network, network), isNotNull(copyExecutionAccounts.address), followerForegroundReadEligible(allowRetainedFairness))).limit(1);
      if (!eligible.length) return null;
      // Never filter by owner enabled, strategy active or agent grant: late
      // receipts are still real money after stop/revocation.
      await tx.execute(sql`insert into copy_follower_scans (account_id)
        select id from copy_execution_accounts where network = ${network} and address is not null
        on conflict (account_id) do nothing`);
      const [row] = await tx.select({ scan: copyFollowerScans, address: copyExecutionAccounts.address, accountCreatedAt: copyExecutionAccounts.createdAt, network: copyExecutionAccounts.network, recovery: sql<boolean>`${followerRecoveryAccount}` })
        .from(copyFollowerScans).innerJoin(copyExecutionAccounts, eq(copyFollowerScans.accountId, copyExecutionAccounts.id))
        .where(and(eq(copyExecutionAccounts.network, network), isNotNull(copyExecutionAccounts.address), followerForegroundReadEligible(allowRetainedFairness), sql`${copyFollowerScans.nextRunAt} <= clock_timestamp()`))
        .orderBy(copyFollowerScans.nextRunAt, copyFollowerScans.accountId).limit(1).for("update", { of: copyFollowerScans, skipLocked: true });
      if (!row?.address) return null;
      const [claimed] = await tx.update(copyFollowerScans).set({ claimToken: randomUUID(), nextRunAt: sql`clock_timestamp() + interval '120 seconds'`, updatedAt: sql`clock_timestamp()` })
        .where(eq(copyFollowerScans.accountId, row.scan.accountId)).returning();
      if (network === 'testnet' && !row.recovery) {
        // Record every ordinary scheduled admission, including idle passes.
        // Only busy periods consult this marker; idle 60/120 s scheduling is
        // unchanged. Null/recovery/foreground claims never consume it.
        await tx.insert(copyFollowerObservationBudget).values({ network, nextAllowedAt: sql`clock_timestamp()`, nextReceiptAllowedAt: sql`clock_timestamp() + interval '300 seconds'` })
          .onConflictDoUpdate({ target: copyFollowerObservationBudget.network, set: { nextReceiptAllowedAt: sql`clock_timestamp() + interval '300 seconds'` } });
      }
      return { ...claimed, address: row.address, accountCreatedAt: row.accountCreatedAt, network: row.network };
    });
  }
  /** Claims one account's scan (of the deployment's network) regardless of its schedule. A pass
   * already holding it loses its claim token, so its save is ignored. */
  claimAccount(accountId: string): Promise<ScanClaim | null> {
    return this.db.transaction(async tx => {
      const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.network, this.network), isNotNull(copyExecutionAccounts.address)));
      if (!account?.address) return null;
      await tx.insert(copyFollowerScans).values({ accountId }).onConflictDoNothing();
      const [claimed] = await tx.update(copyFollowerScans).set({ claimToken: randomUUID(), nextRunAt: sql`clock_timestamp() + interval '120 seconds'`, updatedAt: sql`clock_timestamp()` })
        .where(eq(copyFollowerScans.accountId, accountId)).returning();
      return claimed ? { ...claimed, address: account.address, accountCreatedAt: account.createdAt, network: account.network } : null;
    });
  }
  async save(claim: ScanClaim, scanState: ScanState, through: number | null) {
    return this.db.transaction(async tx => {
      const [account] = await tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, claim.accountId)).for("share");
      if (!account || account.network !== this.network || account.address !== claim.address) throw new LiveBoundaryError("follower_account_identity_changed");
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
