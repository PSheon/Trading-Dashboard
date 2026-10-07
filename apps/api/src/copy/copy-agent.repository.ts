import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyStrategies, copyWalletAuthorizations, copyWalletAuthorizationEvents, users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { lockCopyUser } from "./copy-user-lock.js";
import { allocateSignerNonce } from "./signer-nonce.js";

export type AgentSetupRow = typeof copyAgentSetups.$inferSelect;
@Injectable()
export class CopyAgentRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async owner(userId: number, tx?: DbTransaction) {
    if (tx) await lockCopyUser(tx, userId);
    const query = (tx ?? this.db).select().from(users).where(and(eq(users.id, userId), isNull(users.disabledAt)));
    const [owner] = await (tx ? query.for("update") : query);
    if (!owner) throw new NotFoundException("User not found");
    return owner;
  }
  async account(userId: number, id: string, tx?: DbTransaction) {
    const query = (tx ?? this.db).select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, id), eq(copyExecutionAccounts.userId, userId)));
    const [account] = await (tx ? query.for("update") : query);
    if (!account) throw new NotFoundException("Execution account not found");
    return account;
  }
  async find(userId: number, id: string, tx?: DbTransaction) {
    await this.owner(userId, tx);
    const [row] = await (tx ?? this.db).select().from(copyAgentSetups).where(and(eq(copyAgentSetups.id, id), eq(copyAgentSetups.userId, userId)));
    if (!row) throw new NotFoundException("Agent setup not found");
    return row;
  }
  list(userId: number) { return this.db.select().from(copyAgentSetups).where(eq(copyAgentSetups.userId, userId)).orderBy(desc(copyAgentSetups.createdAt)); }
  async refreshGrant(row: AgentSetupRow): Promise<AgentSetupRow> {
    if (row.state !== "active") return row;
    const [bound] = row.authorizationId ? await this.db.select({ grant: copyWalletAuthorizations, wallet: copyExecutionWallets })
      .from(copyWalletAuthorizations).innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .where(eq(copyWalletAuthorizations.id, row.authorizationId)) : [];
    const revoked = bound?.grant.revokedAt !== null && bound?.grant.revokedAt !== undefined;
    const detached = !bound || bound.wallet.retiredAt !== null || bound.wallet.userId !== row.userId || bound.wallet.strategyId !== row.strategyId ||
      bound.wallet.network !== row.network || bound.wallet.accountAddress !== row.accountAddress || bound.wallet.signerAddress !== row.agentAddress ||
      bound.wallet.privyWalletId !== row.agentWalletId || bound.wallet.privyOwnerId !== row.agentOwnerQuorumId;
    if (revoked || detached) return (await this.transition(row, { state: "revoked", issue: revoked ? "agent_grant_revoked" : "agent_grant_detached" })) ?? await this.find(row.userId, row.id);
    return row;
  }
  async assertCurrent(userId: number, row: AgentSetupRow, tx?: DbTransaction) {
    const owner = await this.owner(userId, tx);
    const account = await this.account(userId, row.accountId, tx);
    const query = (tx ?? this.db).select().from(copyStrategies).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, userId)));
    const [strategy] = await (tx ? query.for("update") : query);
    if (!strategy || strategy.status === "stopped" || strategy.status === "stopping") throw new ConflictException("copy_stopped");
    if (account.state !== "ready" || account.privyUserId !== owner.privyUserId || account.strategyId !== row.strategyId ||
      account.network !== row.network || account.address !== row.accountAddress || account.privyWalletId !== row.accountWalletId || account.ownerQuorumId !== row.accountOwnerQuorumId) {
      throw new ConflictException("agent_account_changed");
    }
    return { owner, account, strategy };
  }
  async ensure(tx: DbTransaction, userId: number, accountId: string, input: { idempotencyKey: string; validForDays: number }, workerQuorumId: string,
    setup: { liveSetupId: string; renewal: boolean } | null = null, network: "testnet" | "mainnet" = "testnet") {
    // Serialize setup admission without holding a transaction across provider calls.
    const owner = await this.owner(userId, tx);
    const account = await this.account(userId, accountId, tx);
    const [prior] = await tx.select().from(copyAgentSetups).where(and(eq(copyAgentSetups.userId, userId), eq(copyAgentSetups.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.accountId !== accountId || prior.validForDays !== input.validForDays || prior.workerQuorumId !== workerQuorumId) throw new ConflictException("agent_idempotency_conflict");
      return prior;
    }
    if (account.state !== "ready" || account.privyUserId !== owner.privyUserId || !account.address || !account.privyWalletId || !account.ownerQuorumId || account.network !== network) throw new ConflictException("agent_account_not_ready");
    const currents = await tx.select().from(copyAgentSetups).where(and(eq(copyAgentSetups.accountId, accountId), sql`${copyAgentSetups.state} not in ('blocked', 'revoked')`));
    if (setup?.renewal) {
      // A renewal prepares the next agent while the current one keeps trading
      // (offered in its last three days): one active and one pending agent may
      // coexist. Approving the new one retires the old grant (activate).
      const active = currents.find(row => row.state === "active");
      if (!active || active.expiresAt.getTime() <= Date.now() || active.expiresAt.getTime() - Date.now() > 3 * 86_400_000 + 3_600_000) throw new ConflictException("agent_renewal_unavailable");
      for (const pending of currents.filter(row => row.state !== "active")) {
        // An abandoned earlier renewal that never reached the exchange.
        if (pending.approvalAttemptedAt) throw new ConflictException("agent_approval_pending");
        await tx.update(copyAgentSetups).set({ state: "blocked", issue: "agent_renewal_abandoned", revision: pending.revision + 1, updatedAt: new Date() }).where(eq(copyAgentSetups.id, pending.id));
      }
    } else for (const current of currents) {
      if (current.expiresAt.getTime() > Date.now()) throw new ConflictException("agent_setup_exists");
      await tx.update(copyAgentSetups).set({ state: "blocked", issue: "agent_expired", revision: current.revision + 1, updatedAt: new Date() }).where(eq(copyAgentSetups.id, current.id));
      if (current.authorizationId) await this.revoke(tx, userId, eq(copyWalletAuthorizations.id, current.authorizationId));
    }
    const id = randomUUID(); const now = new Date();
    const [row] = await tx.insert(copyAgentSetups).values({ id, userId, strategyId: account.strategyId, accountId, network: account.network, ...input,
      externalId: `agent_${id.replaceAll("-", "")}`, policyAttemptId: `policy_${id.replaceAll("-", "")}`, workerQuorumId, liveSetupId: setup?.liveSetupId ?? null,
      accountAddress: account.address, accountWalletId: account.privyWalletId, accountOwnerQuorumId: account.ownerQuorumId,
      expiresAt: new Date(now.getTime() + input.validForDays * 86_400_000), createdAt: now, updatedAt: now }).returning();
    await this.assertCurrent(userId, row!, tx);
    return row!;
  }
  async transition(rawRow: AgentSetupRow, rawChanges: Partial<typeof copyAgentSetups.$inferInsert>, tx?: DbTransaction): Promise<AgentSetupRow | null> {
    const row = structuredClone(rawRow), changes = structuredClone(rawChanges);
    if (!tx) return this.db.transaction(inner => this.transition(row, changes, inner));
    await lockCopyUser(tx, row.userId);
    const [next] = await tx.update(copyAgentSetups).set({ ...changes, revision: row.revision + 1, updatedAt: new Date() })
      .where(and(eq(copyAgentSetups.id, row.id), eq(copyAgentSetups.userId, row.userId), eq(copyAgentSetups.revision, row.revision), eq(copyAgentSetups.state, row.state))).returning();
    return next ?? null;
  }
  async challenge(tx: DbTransaction, userId: number, id: string) {
    const current = await this.find(userId, id, tx);
    await this.assertCurrent(userId, current, tx);
    const [locked] = await tx.select().from(copyAgentSetups).where(and(eq(copyAgentSetups.id, id), eq(copyAgentSetups.userId, userId))).for("update");
    if (!locked) throw new NotFoundException("Agent setup not found");
    await this.assertCurrent(userId, locked, tx);
    if (locked.state !== "ready" || locked.expiresAt.getTime() <= Date.now() + 300_000) throw new ConflictException("agent_not_ready");
    if (locked.approvalAttemptedAt) throw new ConflictException("agent_approval_pending");
    if (locked.approvalNonce && locked.consentExpiresAt && locked.consentExpiresAt.getTime() > Date.now()) return locked;
    const now = Date.now();
    const nonce = await allocateSignerNonce(tx, locked.network, locked.accountAddress, now);
    if (!Number.isSafeInteger(nonce) || nonce > now + 30_000) throw new ConflictException("agent_nonce_clock_skew");
    return (await this.transition(locked, { approvalNonce: nonce, consentExpiresAt: new Date(nonce + 300_000), issue: null }, tx))!;
  }
  async activate(tx: DbTransaction, userId: number, row: AgentSetupRow, observedAt: number, identityCheckedAt: number) {
    await this.assertCurrent(userId, row, tx);
    const [locked] = await tx.select().from(copyAgentSetups).where(and(eq(copyAgentSetups.id, row.id), eq(copyAgentSetups.userId, userId))).for("update");
    if (!locked) throw new NotFoundException("Agent setup not found");
    if (locked.state === "active") return locked;
    if (locked.state !== "approval_unknown" || !locked.approvalAttemptedAt || locked.revision !== row.revision) throw new ConflictException("agent_approval_evidence_stale");
    const assertFresh = () => {
      const now = Date.now();
      if ([observedAt, identityCheckedAt].some(time => !Number.isSafeInteger(time) || time > now || now - time > 5_000)) throw new ConflictException("agent_approval_evidence_stale");
      if (locked.expiresAt.getTime() <= now) throw new ConflictException("agent_expired");
    };
    assertFresh();
    await this.assertCurrent(userId, locked, tx);
    if (locked.expiresAt.getTime() <= Date.now() || !locked.agentWalletId || !locked.agentOwnerQuorumId || !locked.agentAddress) throw new ConflictException("agent_expired");
    // Retire old identities rather than rewriting their historic grant metadata.
    const old = await tx.select().from(copyExecutionWallets).where(and(eq(copyExecutionWallets.network, locked.network), eq(copyExecutionWallets.strategyId, locked.strategyId), isNull(copyExecutionWallets.retiredAt))).for("update");
    assertFresh();
    for (const wallet of old) {
      await this.revoke(tx, userId, eq(copyWalletAuthorizations.walletId, wallet.id));
      await tx.update(copyExecutionWallets).set({ retiredAt: new Date() }).where(eq(copyExecutionWallets.id, wallet.id));
    }
    // A renewal's new agent replaces the account's current one.
    await tx.update(copyAgentSetups).set({ state: "revoked", issue: "agent_renewed", revision: sql`${copyAgentSetups.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(copyAgentSetups.accountId, locked.accountId), eq(copyAgentSetups.state, "active"), sql`${copyAgentSetups.id} <> ${locked.id}`));
    assertFresh();
    const walletId = randomUUID(); const authorizationId = randomUUID();
    await tx.insert(copyExecutionWallets).values({ id: walletId, userId, strategyId: locked.strategyId, network: locked.network, accountAddress: locked.accountAddress,
      privyWalletId: locked.agentWalletId, privyOwnerId: locked.agentOwnerQuorumId, signerAddress: locked.agentAddress });
    await tx.insert(copyWalletAuthorizations).values({ id: authorizationId, walletId, version: 1, scopes: ["copy:trade", "copy:reduce"],
      validFrom: new Date(observedAt), expiresAt: locked.expiresAt, exchangeApprovedAt: new Date(observedAt) });
    const active = (await this.transition(locked, { state: "active", authorizationId, issue: null }, tx))!;
    // Includes waits on old grant rows, insert constraints and the final setup
    // update. Throwing here rolls back retirement, revocation and grant creation.
    assertFresh();
    return active;
  }
  private async revoke(tx: DbTransaction, userId: number, where: ReturnType<typeof eq>) {
    const rows = await tx.update(copyWalletAuthorizations).set({ revokedAt: new Date(), version: sql`${copyWalletAuthorizations.version} + 1` })
      .where(and(where, isNull(copyWalletAuthorizations.revokedAt))).returning();
    for (const grant of rows) await tx.insert(copyWalletAuthorizationEvents).values({ id: randomUUID(), userId, authorizationId: grant.id, version: grant.version, action: "revoked" });
  }
}
