import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { copyExecutionAccounts, copyExecutionWallets, copyStrategies, copyWalletAuthorizations, copyWalletAuthorizationEvents, users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { ProvisioningWalletConflict, type ProvisionedUserWallet } from "./live/privy-wallet-provisioner.js";
import { lockCopyUser } from "./copy-user-lock.js";

export type AccountRow = typeof copyExecutionAccounts.$inferSelect;
export type GrantRow = typeof copyWalletAuthorizations.$inferSelect;
export type AgentRow = typeof copyExecutionWallets.$inferSelect;

@Injectable()
export class CopyWalletRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async enabledOwner(userId: number) {
    return (await this.db.select().from(users).where(and(eq(users.id, userId), isNull(users.disabledAt))))[0];
  }
  async ownedStrategy(userId: number, strategyId: number) {
    return (await this.db.select().from(copyStrategies).where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId))))[0];
  }
  accounts(userId: number) {
    return this.db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.userId, userId)).orderBy(desc(copyExecutionAccounts.createdAt));
  }
  grants(userId: number) {
    return this.db.select({ grant: copyWalletAuthorizations, wallet: copyExecutionWallets }).from(copyWalletAuthorizations)
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .where(eq(copyExecutionWallets.userId, userId)).orderBy(desc(copyWalletAuthorizations.validFrom));
  }
  async ensureAccount(rawInput: typeof copyExecutionAccounts.$inferInsert) {
    const input = structuredClone(rawInput);
    return this.db.transaction(async tx => {
      await lockCopyUser(tx, input.userId);
      const [owner] = await tx.select().from(users).where(and(eq(users.id, input.userId), isNull(users.disabledAt)));
      const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, input.strategyId), eq(copyStrategies.userId, input.userId)));
      if (!owner || owner.privyUserId !== input.privyUserId || !strategy) throw new ConflictException("wallet_owner_mismatch");
      const lookup = and(eq(copyExecutionAccounts.strategyId, input.strategyId), eq(copyExecutionAccounts.network, input.network));
      const [existing] = await tx.select().from(copyExecutionAccounts).where(lookup);
      if (existing) {
        if (existing.userId !== input.userId) throw new ConflictException("wallet_owner_mismatch");
        return existing;
      }
      if (["stopping", "stopped"].includes(strategy.status)) throw new ConflictException("copy_stopped");
      await tx.insert(copyExecutionAccounts).values(input)
        .onConflictDoNothing({ target: [copyExecutionAccounts.network, copyExecutionAccounts.strategyId] });
      const [row] = await tx.select().from(copyExecutionAccounts).where(lookup);
      if (row && row.userId !== input.userId) throw new ConflictException("wallet_owner_mismatch");
      return row;
    });
  }
  async account(id: string, userId?: number) {
    return (await this.db.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, id), userId === undefined ? undefined : eq(copyExecutionAccounts.userId, userId))))[0];
  }
  async claimCreation(id: string) {
    return this.withLockedAccount(id, async tx => (await tx.update(copyExecutionAccounts).set({ state: "unknown", issue: "verification_pending", updatedAt: new Date(), revision: sql`${copyExecutionAccounts.revision} + 1` })
      .where(and(eq(copyExecutionAccounts.id, id), eq(copyExecutionAccounts.state, "requested"))).returning())[0]);
  }
  async confirmIdentity(id: string, rawIdentity: ProvisionedUserWallet) {
    const found = structuredClone(rawIdentity);
    try { return await this.withLockedAccount(id, async tx => (await tx.update(copyExecutionAccounts).set({ state: "ready", issue: null, privyWalletId: found.id,
      address: found.address, ownerQuorumId: found.ownerQuorumId, updatedAt: new Date(), revision: sql`${copyExecutionAccounts.revision} + 1` })
      .where(and(eq(copyExecutionAccounts.id, id), sql`${copyExecutionAccounts.state} <> 'blocked'`,
        sql`(${copyExecutionAccounts.privyWalletId} is null or (${copyExecutionAccounts.privyWalletId} = ${found.id} and ${copyExecutionAccounts.address} = ${found.address} and ${copyExecutionAccounts.ownerQuorumId} = ${found.ownerQuorumId}))`)).returning())[0]);
    } catch (error) {
      // Drizzle wraps the pg SQLSTATE in cause. Reusing a wallet/address bound
      // to another account is a permanent identity conflict, not an outage.
      const cause = error && typeof error === "object" && "cause" in error ? error.cause : error;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505") throw new ProvisioningWalletConflict("wallet_conflict");
      throw error;
    }
  }
  /** The worker became this ready account's policy-bound signer. Identity is
   * unchanged, so the revision (which consents bind) stays as it is. */
  async recordMasterSigner(id: string, fields: { masterPolicyId: string; masterPolicyFingerprint: string; masterSignerQuorumId: string; sweepDestination: string; signerAttachedAt: Date; walletId: string; address: string }) {
    return this.withLockedAccount(id, async tx => (await tx.update(copyExecutionAccounts).set({ masterPolicyId: fields.masterPolicyId, masterPolicyFingerprint: fields.masterPolicyFingerprint,
      masterSignerQuorumId: fields.masterSignerQuorumId, sweepDestination: fields.sweepDestination, signerAttachedAt: fields.signerAttachedAt, updatedAt: new Date() })
      .where(and(eq(copyExecutionAccounts.id, id), eq(copyExecutionAccounts.state, "ready"), eq(copyExecutionAccounts.privyWalletId, fields.walletId), eq(copyExecutionAccounts.address, fields.address),
        sql`${copyExecutionAccounts.masterPolicyId} is null`)).returning())[0]);
  }
  async failReverification(id: string, revision: number, issue: AccountRow["issue"]) {
    await this.withLockedAccount(id, tx => tx.update(copyExecutionAccounts).set({ state: "unknown", issue, updatedAt: new Date(), revision: sql`${copyExecutionAccounts.revision} + 1` })
      .where(and(eq(copyExecutionAccounts.id, id), eq(copyExecutionAccounts.state, "ready"), eq(copyExecutionAccounts.revision, revision))));
  }
  async finish(id: string, state: AccountRow["state"], issue: AccountRow["issue"]) {
    await this.withLockedAccount(id, tx => tx.update(copyExecutionAccounts).set({ state, issue, updatedAt: new Date(), revision: sql`${copyExecutionAccounts.revision} + 1` })
      .where(and(eq(copyExecutionAccounts.id, id), state === "blocked" ? sql`true` :
        state === "requested" ? eq(copyExecutionAccounts.state, "requested") : sql`${copyExecutionAccounts.state} in ('requested', 'unknown')`)));
  }
  private async withLockedAccount<T>(id: string, write: (tx: DbTransaction) => PromiseLike<T>): Promise<T | undefined> {
    return this.db.transaction(async tx => {
      const [lookup] = await tx.select({ userId: copyExecutionAccounts.userId }).from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, id));
      if (!lookup) return undefined;
      await lockCopyUser(tx, lookup.userId);
      const [current] = await tx.select({ userId: copyExecutionAccounts.userId }).from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, id)).for("update");
      if (!current || current.userId !== lookup.userId) throw new ConflictException("wallet_owner_mismatch");
      return write(tx);
    });
  }
  async lockedGrant(tx: DbTransaction, userId: number, id: string) {
    await lockCopyUser(tx, userId);
    return (await tx.select({ grant: copyWalletAuthorizations, wallet: copyExecutionWallets }).from(copyWalletAuthorizations)
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .where(and(eq(copyWalletAuthorizations.id, id), eq(copyExecutionWallets.userId, userId))).for("update", { of: copyWalletAuthorizations }))[0];
  }
  async revokeGrant(tx: DbTransaction, id: string, version: number, now: Date) {
    return (await tx.update(copyWalletAuthorizations).set({ revokedAt: now, version })
      .where(eq(copyWalletAuthorizations.id, id)).returning())[0];
  }
  recordRevocation(tx: DbTransaction, event: typeof copyWalletAuthorizationEvents.$inferInsert) {
    return tx.insert(copyWalletAuthorizationEvents).values(event);
  }
}
