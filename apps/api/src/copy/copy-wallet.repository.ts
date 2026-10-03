import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { copyExecutionAccounts, copyExecutionWallets, copyStrategies, copyWalletAuthorizations, copyWalletAuthorizationEvents, users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { ProvisioningWalletConflict, type ProvisionedUserWallet } from "./live/privy-wallet-provisioner.js";

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
  async ensureAccount(input: typeof copyExecutionAccounts.$inferInsert) {
    await this.db.insert(copyExecutionAccounts).values(input)
      .onConflictDoNothing({ target: [copyExecutionAccounts.network, copyExecutionAccounts.strategyId] });
    return (await this.db.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.strategyId, input.strategyId), eq(copyExecutionAccounts.network, input.network))))[0];
  }
  async account(id: string, userId?: number) {
    return (await this.db.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, id), userId === undefined ? undefined : eq(copyExecutionAccounts.userId, userId))))[0];
  }
  async claimCreation(id: string) {
    return (await this.db.update(copyExecutionAccounts).set({ state: "unknown", issue: "verification_pending", updatedAt: new Date(), revision: sql`${copyExecutionAccounts.revision} + 1` })
      .where(and(eq(copyExecutionAccounts.id, id), eq(copyExecutionAccounts.state, "requested"))).returning())[0];
  }
  async confirmIdentity(id: string, found: ProvisionedUserWallet) {
    try { return (await this.db.update(copyExecutionAccounts).set({ state: "ready", issue: null, privyWalletId: found.id,
      address: found.address, ownerQuorumId: found.ownerQuorumId, updatedAt: new Date(), revision: sql`${copyExecutionAccounts.revision} + 1` })
      .where(and(eq(copyExecutionAccounts.id, id), sql`${copyExecutionAccounts.state} <> 'blocked'`,
        sql`(${copyExecutionAccounts.privyWalletId} is null or (${copyExecutionAccounts.privyWalletId} = ${found.id} and ${copyExecutionAccounts.address} = ${found.address} and ${copyExecutionAccounts.ownerQuorumId} = ${found.ownerQuorumId}))`)).returning())[0];
    } catch (error) {
      // Drizzle wraps the pg SQLSTATE in cause. Reusing a wallet/address bound
      // to another account is a permanent identity conflict, not an outage.
      const cause = error && typeof error === "object" && "cause" in error ? error.cause : error;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505") throw new ProvisioningWalletConflict("wallet_conflict");
      throw error;
    }
  }
  async failReverification(id: string, revision: number, issue: AccountRow["issue"]) {
    await this.db.update(copyExecutionAccounts).set({ state: "unknown", issue, updatedAt: new Date(), revision: sql`${copyExecutionAccounts.revision} + 1` })
      .where(and(eq(copyExecutionAccounts.id, id), eq(copyExecutionAccounts.state, "ready"), eq(copyExecutionAccounts.revision, revision)));
  }
  async finish(id: string, state: AccountRow["state"], issue: AccountRow["issue"]) {
    await this.db.update(copyExecutionAccounts).set({ state, issue, updatedAt: new Date(), revision: sql`${copyExecutionAccounts.revision} + 1` })
      .where(and(eq(copyExecutionAccounts.id, id), state === "blocked" ? sql`true` :
        state === "requested" ? eq(copyExecutionAccounts.state, "requested") : sql`${copyExecutionAccounts.state} in ('requested', 'unknown')`));
  }
  async lockedGrant(tx: DbTransaction, userId: number, id: string) {
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
