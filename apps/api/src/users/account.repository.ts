import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { copyExecutionAccounts, copyStrategies, favoriteGroups, notificationChannels, referralCodes, userFavorites, users } from "@trading-dashboard/shared/database";

import { recordAdminAudit } from "../common/audit/admin-audit.js";
import { AppConfig } from "../config/app-config.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { lockCopyUser } from "../copy/copy-user-lock.js";
import { unwatchLeaderIfUnused } from "../watcher/leader-watch.js";
import { recordDeletedIdentity, type DeletedIdentity } from "./deletion-markers.js";
import { deletedBeforeUser, KEPT_STRATEGY, repointStatements, type UserReference } from "./account-closure.plan.js";

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
 * What stops a deletion: only state still in flight (docs/account-deletion.md).
 * In the order the dialog shows them; history never blocks.
 */
export const DELETION_BLOCKERS = [
  "copies_active", "stop_in_progress", "setup_in_progress", "transfer_pending", "execution_pending",
  "copy_account_not_empty", "withdrawal_pending", "referral_claim_pending",
] as const;
export type DeletionBlockerCode = (typeof DELETION_BLOCKERS)[number];
export interface DeletionBlocker { code: DeletionBlockerCode; strategyIds: number[] }

/** What was prepared but never sent, cancelled by the deletion itself. */
export interface UnsentCancelled { setups: number; transfers: number; withdrawals: number; copies: number; mandates: number }

/** A copy account the exchange is asked about, and one whose wallet still
 * carries the worker as a signer. */
export interface ClosureAccount { id: string; strategyId: number; network: "testnet" | "mainnet"; address: string }
export interface ClosureSigner { id: string; walletId: string }

const ids = (rows: Array<{ strategy_id: number | null }>) => [...new Set(rows.flatMap((r) => r.strategy_id === null ? [] : [Number(r.strategy_id)]))].sort((a, b) => a - b);

/**
 * Persistence for self-service account deletion. Every method takes the
 * caller's transaction; {@link AccountDeletionService} owns it.
 */
@Injectable()
export class AccountRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, @Optional() private readonly config?: AppConfig) {}

  lockCopyOwner(tx: DbTransaction, userId: number) { return lockCopyUser(tx, userId); }

  /** Locks every enabled admin row, in id order (the same order as admin
   * user edits, so the two can't deadlock). */
  lockEnabledAdmins(tx: DbTransaction) {
    return tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), isNull(users.disabledAt))).orderBy(asc(users.id)).for("update");
  }

  /** The user row, locked; undefined when it no longer exists (or is a tombstone). */
  async lockUser(tx: DbTransaction, userId: number) {
    const [row] = await tx.select({ id: users.id, role: users.role, disabledAt: users.disabledAt, createdAt: users.createdAt, privyUserId: users.privyUserId,
      email: users.email, walletAddress: users.walletAddress, embeddedWalletAddress: users.embeddedWalletAddress }).from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt))).for("update");
    return row;
  }

  /**
   * Cancels what was prepared but never sent, so it doesn't block: a
   * one-click setup still before its deposit was attempted (and the start's
   * empty copy), copy deposits/returns and main-wallet withdrawals never
   * attempted, an unfunded testnet copy that never ran, and a consent
   * generation never activated. Anything attempted is left for the blockers.
   */
  async cancelUnsent(tx: DbTransaction, userId: number): Promise<UnsentCancelled> {
    const setups = await tx.execute<{ id: string }>(sql`
      update copy_live_setups s set stage = 'cancelled', issue = null, revision = s.revision + 1, updated_at = now()
      where s.user_id = ${userId} and s.stage in ('provisioning', 'awaiting_consent')
        and not exists (select 1 from copy_funding_operations f where f.id = s.funding_operation_id and f.attempted_at is not null)
      returning s.id`);
    const transfers = await tx.execute<{ id: string }>(sql`
      update copy_funding_operations set status = 'cancelled', updated_at = now()
      where user_id = ${userId} and status in ('prepared', 'unknown') and attempted_at is null returning id`);
    const withdrawals = await tx.execute<{ id: string }>(sql`
      update wallet_withdrawals set status = 'cancelled', updated_at = now()
      where user_id = ${userId} and (status = 'prepared' or (status = 'unknown' and origin = 'client' and attempted_at is null)) returning id`);
    const copies = await tx.execute<{ id: number }>(sql`
      update copy_strategies s set status = 'stopped', pause_new_risk = true, stopped_at = now()
      where s.user_id = ${userId} and s.mode = 'testnet' and s.status = 'paused'
        and not exists (select 1 from copy_live_mandates m where m.strategy_id = s.id and m.state in ('active', 'paused', 'stopping', 'stopped'))
        and not exists (select 1 from copy_funding_operations f where f.strategy_id = s.id and f.status not in ('cancelled', 'rejected'))
        and not exists (select 1 from copy_live_executions e where e.strategy_id = s.id)
        and not exists (select 1 from copy_live_stop_operations o where o.strategy_id = s.id)
        and not exists (select 1 from copy_live_setups x where x.strategy_id = s.id and x.stage not in ('failed', 'expired', 'cancelled'))
      returning s.id`);
    const mandates = await tx.execute<{ id: string }>(sql`
      update copy_live_mandates set state = 'revoked', revision = revision + 1, updated_at = greatest(now(), created_at)
      where user_id = ${userId} and state = 'prepared' returning id`);
    return { setups: setups.rows.length, transfers: transfers.rows.length, withdrawals: withdrawals.rows.length, copies: copies.rows.length, mandates: mandates.rows.length };
  }

  /** Everything still in flight, by code, with the copies concerned. Paper
   * copies never block: they are deleted with the account. */
  async blockers(tx: DbTransaction, userId: number): Promise<DeletionBlocker[]> {
    const found: Array<[DeletionBlockerCode, number[] | null]> = [];
    const copies = await tx.execute<{ strategy_id: number }>(sql`
      select s.id as strategy_id from copy_strategies s where s.user_id = ${userId} and s.status <> 'stopped' and ${KEPT_STRATEGY}
      union select strategy_id from copy_live_mandates where user_id = ${userId} and state in ('active', 'paused', 'stopping')`);
    if (copies.rows.length) found.push(["copies_active", ids(copies.rows)]);
    const stops = await tx.execute<{ strategy_id: number }>(sql`select strategy_id from copy_live_stop_operations where user_id = ${userId} and state <> 'stopped'`);
    if (stops.rows.length) found.push(["stop_in_progress", ids(stops.rows)]);
    const setups = await tx.execute<{ strategy_id: number }>(sql`select strategy_id from copy_live_setups where user_id = ${userId} and stage not in ('running', 'failed', 'expired', 'cancelled')`);
    if (setups.rows.length) found.push(["setup_in_progress", ids(setups.rows)]);
    const transfers = await tx.execute<{ strategy_id: number }>(sql`select strategy_id from copy_funding_operations where user_id = ${userId} and status in ('prepared', 'unknown', 'accepted')`);
    if (transfers.rows.length) found.push(["transfer_pending", ids(transfers.rows)]);
    const executions = await tx.execute<{ strategy_id: number }>(sql`select strategy_id from copy_live_executions where user_id = ${userId} and state in ('prepared', 'submitting', 'unknown', 'resting', 'partial')`);
    if (executions.rows.length) found.push(["execution_pending", ids(executions.rows)]);
    const [withdrawal] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from wallet_withdrawals where user_id = ${userId} and status in ('prepared', 'unknown')`)).rows;
    if (Number(withdrawal?.n ?? 0) > 0) found.push(["withdrawal_pending", null]);
    const [claim] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from referral_claims where user_id = ${userId} and status in ('requested', 'approved', 'sending', 'unknown')`)).rows;
    if (Number(claim?.n ?? 0) > 0) found.push(["referral_claim_pending", null]);
    return found.map(([code, strategyIds]) => ({ code, strategyIds: strategyIds ?? [] }));
  }

  /** Copy accounts with a known address: each must be empty on the exchange. */
  async closureAccounts(tx: DbTransaction, userId: number): Promise<ClosureAccount[]> {
    const rows = await tx.select({ id: copyExecutionAccounts.id, strategyId: copyExecutionAccounts.strategyId, network: copyExecutionAccounts.network, address: copyExecutionAccounts.address })
      .from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.userId, userId), sql`${copyExecutionAccounts.address} is not null`)).orderBy(asc(copyExecutionAccounts.createdAt), asc(copyExecutionAccounts.id));
    return rows.map((r) => ({ ...r, address: r.address! }));
  }

  /** Wallets that still carry the worker quorum as an additional signer. */
  async attachedSigners(tx: DbTransaction | DrizzleDb, userId: number): Promise<ClosureSigner[]> {
    const rows = await tx.select({ id: copyExecutionAccounts.id, walletId: copyExecutionAccounts.privyWalletId }).from(copyExecutionAccounts)
      .where(and(eq(copyExecutionAccounts.userId, userId), sql`${copyExecutionAccounts.masterSignerQuorumId} is not null`, isNull(copyExecutionAccounts.signerDetachedAt)));
    return rows.flatMap((r) => r.walletId ? [{ id: r.id, walletId: r.walletId }] : []);
  }

  /** Records that the worker was taken off this account's wallet. */
  async recordSignerDetached(accountId: string): Promise<void> {
    await this.db.execute(sql`update copy_execution_accounts set signer_detached_at = greatest(now(), signer_attached_at), updated_at = now()
      where id = ${accountId} and signer_attached_at is not null and signer_detached_at is null`);
  }

  /** Revokes every server-signing grant and agent of the user (the copies
   * are stopped by now): grants get a revocation event, agents `revoked`. */
  async revokeAuthorizations(tx: DbTransaction, userId: number): Promise<{ grants: number; agents: number }> {
    const grants = await tx.execute<{ id: string }>(sql`
      with revoked as (
        update copy_wallet_authorizations a set revoked_at = now(), version = a.version + 1
        where a.revoked_at is null and a.wallet_id in (select id from copy_execution_wallets where user_id = ${userId})
        returning a.id, a.version)
      insert into copy_wallet_authorization_events (id, authorization_id, user_id, version, action, created_at)
      select gen_random_uuid()::text, revoked.id, ${userId}, revoked.version, 'revoked', now() from revoked
      returning authorization_id as id`);
    const agents = await tx.execute<{ id: string }>(sql`
      update copy_agent_setups set state = 'revoked', issue = 'account_deleted', revision = revision + 1, updated_at = now()
      where user_id = ${userId} and state not in ('blocked', 'revoked') returning id`);
    return { grants: grants.rows.length, agents: agents.rows.length };
  }

  /** The deletion's tombstone: a disabled row with no personal data. Keeps
   * the sign-up time only, so an inviter's list still reads sensibly. */
  async createTombstone(tx: DbTransaction, createdAt: Date): Promise<number> {
    const now = new Date();
    const [row] = await tx.insert(users).values({ privyUserId: `deleted:${randomUUID()}`, role: "user", createdAt, lastLoginAt: now, disabledAt: now, deletedAt: now })
      .returning({ id: users.id });
    return row!.id;
  }

  /** Re-points every kept record to the tombstone; the counts per column. */
  async repoint(tx: DbTransaction, userId: number, tombstoneId: number): Promise<Partial<Record<UserReference, number>>> {
    const kept: Partial<Record<UserReference, number>> = {};
    for (const { reference, statement } of repointStatements(userId, tombstoneId)) {
      const result = await tx.execute(statement);
      if (result.rowCount) kept[reference] = result.rowCount;
    }
    return kept;
  }

  /** Favorited addresses (the watch list may need them released). */
  async favoriteAddresses(tx: DbTransaction, userId: number): Promise<string[]> {
    const rows = await tx.select({ address: userFavorites.address }).from(userFavorites).where(eq(userFavorites.userId, userId));
    return rows.map((r) => r.address);
  }

  /** Leaders the user's remaining (paper) copies follow, released after the delete. */
  async copiedLeaders(tx: DbTransaction, userId: number): Promise<string[]> {
    const rows = await tx.selectDistinct({ address: copyStrategies.leaderAddress }).from(copyStrategies).where(eq(copyStrategies.userId, userId));
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
   * Deletes the user row. Call after {@link repoint}: what is left cascades
   * (favorites, groups and members, alert rules and history, Telegram link
   * and tokens, queued notifications, paper copies and the paper balance);
   * referral codes nobody was invited with go first (RESTRICT); settings the
   * user edited keep their value with `updated_by_user_id` null. The watch
   * list is released afterwards ({@link unwatch}).
   */
  async deleteUser(tx: DbTransaction, userId: number): Promise<boolean> {
    for (const statement of Object.values(deletedBeforeUser(userId))) await tx.execute(statement);
    await tx.delete(referralCodes).where(eq(referralCodes.userId, userId));
    const rows = await tx.delete(users).where(and(eq(users.id, userId), isNull(users.deletedAt))).returning({ id: users.id });
    return rows.length > 0;
  }

  /** Stops watching leaders nobody favorites or copies any more. */
  async unwatch(tx: DbTransaction, addresses: Iterable<string>): Promise<void> {
    for (const address of new Set(addresses)) await unwatchLeaderIfUnused(tx, address);
  }

  /** Keeps the deleted identity as keyed hashes only, so signing up again
   * within the retention window can't bind a new referral (deletion-markers.ts). */
  recordIdentity(tx: DbTransaction, identity: DeletedIdentity): Promise<number> {
    return recordDeletedIdentity(tx, identity, this.config);
  }

  /** Removes a tombstone nothing was re-pointed to. */
  async dropTombstone(tx: DbTransaction, tombstoneId: number): Promise<void> {
    await tx.delete(users).where(and(eq(users.id, tombstoneId), isNotNull(users.deletedAt)));
  }

  /** The admin audit entry for a self-service deletion: counts only, under
   * the tombstone when records were kept (the old id is only the target). */
  recordDeletion(tx: DbTransaction, userId: number, tombstoneId: number | null, before: AccountFootprint, after: Record<string, unknown>) {
    return recordAdminAudit(tx, tombstoneId ?? userId, "user.delete", `user:${userId}`, before, { tombstoneUserId: tombstoneId, ...after });
  }
}
