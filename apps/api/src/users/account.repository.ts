import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, isNull, ne, or } from "drizzle-orm";
import { copyStrategies, copyExecutionAccounts, copyExecutionWallets, copyLiveExecutions, notificationChannels, favoriteGroups, userFavorites, users, walletWithdrawals,
  referralAttributions, referralClaims, referralCodes, referralLedger } from "@trading-dashboard/shared/database";

import { recordAdminAudit } from "../common/audit/admin-audit.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { lockCopyUser } from "../copy/copy-user-lock.js";

/** What an account holds at deletion time: counts only, for the audit
 * record (no email, Privy id, addresses or chat ids). */
export interface AccountFootprint {
  role: string;
  favorites: number;
  alerts: number;
  groups: number;
  telegramLinked: boolean;
}

/**
 * Persistence for self-service account deletion. Every method takes the
 * caller's transaction; {@link AccountDeletionService} owns it.
 */
@Injectable()
export class AccountRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  lockCopyOwner(tx: DbTransaction, userId: number) { return lockCopyUser(tx, userId); }

  /** Locks every enabled admin row, in id order (the same order as admin
   * user edits, so the two can't deadlock). */
  lockEnabledAdmins(tx: DbTransaction) {
    return tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), isNull(users.disabledAt))).orderBy(asc(users.id)).for("update");
  }

  /** The user row, locked; undefined when it no longer exists. */
  /** Whether the user still has a copy that isn't stopped (its funds are still allocated). */
  async hasLiveCopies(tx: DbTransaction, userId: number): Promise<boolean> {
    const [row] = await tx.select({ n: count() }).from(copyStrategies).where(and(eq(copyStrategies.userId, userId), ne(copyStrategies.status, "stopped")));
    return Number(row?.n ?? 0) > 0;
  }

  async hasExecutionRecords(tx: DbTransaction, userId: number): Promise<boolean> {
    const [account] = await tx.select({ id: copyExecutionAccounts.id }).from(copyExecutionAccounts).where(eq(copyExecutionAccounts.userId, userId)).limit(1);
    const [wallet] = await tx.select({ id: copyExecutionWallets.id }).from(copyExecutionWallets).where(eq(copyExecutionWallets.userId, userId)).limit(1);
    const [execution] = await tx.select({ key: copyLiveExecutions.key }).from(copyLiveExecutions).where(eq(copyLiveExecutions.userId, userId)).limit(1);
    const [withdrawal] = await tx.select({ id: walletWithdrawals.id }).from(walletWithdrawals).where(eq(walletWithdrawals.userId, userId)).limit(1);
    return Boolean(account || wallet || execution || withdrawal);
  }
  async hasReferralRecords(tx: DbTransaction, userId: number): Promise<boolean> {
    const [attribution] = await tx.select({ id: referralAttributions.id }).from(referralAttributions)
      .where(or(eq(referralAttributions.referrerUserId, userId), eq(referralAttributions.referredUserId, userId))).limit(1);
    const [claim] = await tx.select({ id: referralClaims.id }).from(referralClaims).where(eq(referralClaims.userId, userId)).limit(1);
    const [entry] = await tx.select({ id: referralLedger.id }).from(referralLedger).where(eq(referralLedger.userId, userId)).limit(1);
    return Boolean(attribution || claim || entry);
  }

  async lockUser(tx: DbTransaction, userId: number) {
    const [row] = await tx.select({ id: users.id, role: users.role, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId)).for("update");
    return row;
  }

  /** Favorited addresses (the watch list may need them released). */
  async favoriteAddresses(tx: DbTransaction, userId: number): Promise<string[]> {
    const rows = await tx.select({ address: userFavorites.address }).from(userFavorites).where(eq(userFavorites.userId, userId));
    return rows.map((r) => r.address);
  }

  async footprint(tx: DbTransaction, userId: number, role: string): Promise<AccountFootprint> {
    // One transaction is one connection: run the counts one after another.
    const [fav] = await tx.select({ n: count() }).from(userFavorites).where(eq(userFavorites.userId, userId));
    const [alerts] = await tx.select({ n: count() }).from(userFavorites).where(and(eq(userFavorites.userId, userId), eq(userFavorites.alertEnabled, true)));
    const [groups] = await tx.select({ n: count() }).from(favoriteGroups).where(eq(favoriteGroups.userId, userId));
    const [telegram] = await tx.select({ n: count() }).from(notificationChannels).where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, "telegram")));
    return { role, favorites: fav?.n ?? 0, alerts: alerts?.n ?? 0, groups: groups?.n ?? 0, telegramLinked: (telegram?.n ?? 0) > 0 };
  }

  /**
   * Deletes the user row. Foreign keys cascade to favorites, their groups
   * and members, alert rules and alert history, Telegram channels and link
   * tokens, and queued notifications; settings they edited keep the value
   * with `updated_by_user_id` set to null. Call after the favorites have
   * been released from the watch list in the same transaction.
   */
  async deleteUser(tx: DbTransaction, userId: number): Promise<boolean> {
    // Called after the retained attribution/financial-history check, under
    // the same user fence used by bind/code/claim writers.
    await tx.delete(referralCodes).where(eq(referralCodes.userId, userId));
    const rows = await tx.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
    return rows.length > 0;
  }

  /** The admin audit entry for a self-service deletion (counts only). */
  recordDeletion(tx: DbTransaction, userId: number, before: AccountFootprint) {
    return recordAdminAudit(tx, userId, "user.delete", `user:${userId}`, before, null);
  }
}
