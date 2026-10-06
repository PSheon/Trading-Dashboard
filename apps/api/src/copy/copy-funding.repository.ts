import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql, or } from "drizzle-orm";
import { copyExecutionAccounts, copyFundingOperations, copyRiskPolicies, copyStrategies, users, walletWithdrawals } from "@trading-dashboard/shared/database";
import type { CopyFundingInput } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { expireStaleReturns } from "./copy-live-return.repository.js";
import { lockCopyUser } from "./copy-user-lock.js";
import type { FundingScan } from "./copy-funding-scan.js";

export type FundingRow = typeof copyFundingOperations.$inferSelect;
const pending = () => inArray(copyFundingOperations.status, ["prepared", "unknown", "accepted"]);
const conflict = () => new ConflictException({ statusCode: 409, code: "funding_pending", message: "Resolve the pending wallet operation first" });

@Injectable()
export class CopyFundingRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  private locked<T>(userId: number, write: (tx: DbTransaction) => PromiseLike<T>): Promise<T> {
    return this.db.transaction(async tx => { await lockCopyUser(tx, userId); return write(tx); });
  }
  list(userId: number) {
    return this.db.select().from(copyFundingOperations).where(eq(copyFundingOperations.userId, userId))
      .orderBy(sql`case when ${copyFundingOperations.status} in ('prepared', 'unknown', 'accepted') then 0 else 1 end`, desc(copyFundingOperations.createdAt)).limit(100);
  }
  async find(userId: number, id: string) {
    const [row] = await this.db.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId)));
    if (!row) throw new NotFoundException("Funding operation not found");
    return row;
  }
  /** Fair bounded read-reconciliation admission across worker replicas. The
   * lease never grants submission rights or changes the transfer status. */
  claimPending(limit: number) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(copyFundingOperations)
        .where(and(inArray(copyFundingOperations.status, ["unknown", "accepted"]), sql`${copyFundingOperations.attemptedAt} is not null`, sql`${copyFundingOperations.updatedAt} < now() - interval '30 seconds'`))
        .orderBy(copyFundingOperations.updatedAt).limit(Math.min(Math.max(limit, 1), 5)).for("update", { skipLocked: true });
      if (!rows.length) return [];
      return tx.update(copyFundingOperations).set({ updatedAt: new Date() }).where(inArray(copyFundingOperations.id, rows.map((row) => row.id))).returning();
    });
  }
  /** `guard` sees the owner and what the account already holds from deposits
   * (sent or pending, less credited returns) inside the reservation's lock,
   * and throws to refuse it (the deployment's allowlist and allocation cap). */
  async reserve(userId: number, accountId: string, network: FundingRow["network"], rawInput: CopyFundingInput,
    guard?: (context: { privyUserId: string; depositedUsd: string; policyMaxAllocationUsd: number | null }) => void) {
    const input = structuredClone(rawInput);
    return this.locked(userId, async (tx) => {
      const [user] = await tx.select().from(users).where(and(eq(users.id, userId), isNull(users.disabledAt))).for("update");
      if (!user?.embeddedWalletAddress) throw new NotFoundException("Wallet not found");
      const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.userId, userId))).for("share");
      if (!account || account.privyUserId !== user.privyUserId) throw new NotFoundException("Execution account not found");
      if (account.state !== "ready" || !account.address || account.network !== network || account.address === user.embeddedWalletAddress) throw new ConflictException("Execution account is not ready");
      const [original] = await tx.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.idempotencyKey, input.idempotencyKey)));
      if (original) {
        if (original.accountId !== accountId || original.network !== network || original.amount !== input.amount || original.address !== user.embeddedWalletAddress || original.destination !== account.address) throw new ConflictException("Idempotency payload changed");
        return original;
      }
      const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, account.strategyId), eq(copyStrategies.userId, userId))).for("share");
      if (!strategy || ["stopping", "stopped"].includes(strategy.status)) throw new ConflictException("Copy is stopped");
      if (guard) {
        const held = await tx.execute<{ deposited: string }>(sql`select (coalesce(sum(case when direction = 'to_account' and status in ('prepared','unknown','accepted','credited') then amount::numeric end), 0)
          - coalesce(sum(case when direction = 'to_main' and status = 'credited' then coalesce(credited_amount, amount)::numeric end), 0))::text as deposited
          from copy_funding_operations where account_id = ${accountId}`);
        const [policy] = await tx.select({ limits: copyRiskPolicies.limits }).from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(1);
        const max = (policy?.limits as { maxAllocationUsd?: unknown } | undefined)?.maxAllocationUsd;
        guard({ privyUserId: user.privyUserId, depositedUsd: held.rows[0]?.deposited ?? "0", policyMaxAllocationUsd: typeof max === "number" ? max : null });
      }
      const source = and(eq(copyFundingOperations.network, network), eq(copyFundingOperations.address, user.embeddedWalletAddress));
      await expireStaleReturns(tx, accountId);
      // Either direction on this copy account: a return to the main wallet in
      // flight excludes a new deposit, as a deposit in flight excludes a return.
      if ((await tx.select({ id: copyFundingOperations.id }).from(copyFundingOperations).where(and(or(source, eq(copyFundingOperations.accountId, accountId)), pending())).limit(1)).length ||
          (await tx.select({ id: walletWithdrawals.id }).from(walletWithdrawals).where(and(eq(walletWithdrawals.network, network), eq(walletWithdrawals.address, user.embeddedWalletAddress), inArray(walletWithdrawals.status, ["prepared", "unknown"]))).limit(1)).length) throw conflict();
      const clock = await tx.execute<{ nonce: number }>(sql`select greatest(floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
        coalesce((select max(nonce) + 1 from copy_funding_operations where network = ${network} and address = ${user.embeddedWalletAddress}), 0),
        coalesce((select max(nonce) + 1 from wallet_withdrawals where network = ${network} and address = ${user.embeddedWalletAddress}), 0))::float8 as nonce`);
      const [row] = await tx.insert(copyFundingOperations).values({ id: randomUUID(), userId, accountId, strategyId: account.strategyId,
        ...input, network, address: user.embeddedWalletAddress, destination: account.address, nonce: clock.rows[0]!.nonce }).returning();
      return row!;
    });
  }
  async claim(userId: number, id: string) {
    const [row] = await this.locked(userId, tx => tx.update(copyFundingOperations).set({ status: "unknown", claimedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.status, "prepared"))).returning());
    return { row: row ?? await this.find(userId, id), claimed: Boolean(row) };
  }
  async cancel(userId: number, id: string) {
    const [row] = await this.locked(userId, tx => tx.update(copyFundingOperations).set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), inArray(copyFundingOperations.status, ["prepared", "unknown"]), isNull(copyFundingOperations.attemptedAt))).returning());
    const current = row ?? await this.find(userId, id);
    if (current.status !== "cancelled") throw conflict();
    return current;
  }
  async beginSubmit(userId: number, id: string) {
    // Serialize against owner disablement, account re-verification and copy stop.
    return this.locked(userId, async (tx) => {
      const [user] = await tx.select().from(users).where(and(eq(users.id, userId), isNull(users.disabledAt))).for("share");
      const [row] = await tx.select().from(copyFundingOperations).where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId)));
      if (!row) throw new NotFoundException("Funding operation not found");
      if (!user || user.embeddedWalletAddress !== row.address) throw new ConflictException("Wallet identity changed");
      const [account] = await tx.select().from(copyExecutionAccounts).where(and(eq(copyExecutionAccounts.id, row.accountId), eq(copyExecutionAccounts.userId, userId))).for("share");
      const [strategy] = await tx.select().from(copyStrategies).where(and(eq(copyStrategies.id, row.strategyId), eq(copyStrategies.userId, userId))).for("share");
      if (!account || account.privyUserId !== user.privyUserId || account.network !== row.network || account.address !== row.destination || account.state !== "ready" || !strategy || ["stopping", "stopped"].includes(strategy.status)) throw new ConflictException("Execution account is not ready");
      const [claimed] = await tx.update(copyFundingOperations).set({ attemptedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.status, "unknown"), sql`${copyFundingOperations.claimedAt} is not null`, isNull(copyFundingOperations.attemptedAt))).returning();
      return claimed ?? null;
    });
  }
  async restoreUnsent(userId: number, id: string) {
    await this.locked(userId, tx => tx.update(copyFundingOperations).set({ status: "prepared", claimedAt: null, updatedAt: new Date() })
      .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.status, "unknown"), isNull(copyFundingOperations.attemptedAt))));
  }
  async finish(userId: number, id: string, status: "accepted" | "rejected", evidenceHash: string) {
    const [row] = await this.locked(userId, tx => tx.update(copyFundingOperations).set({ status, evidenceHash, updatedAt: new Date() })
      .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.status, "unknown"), sql`${copyFundingOperations.attemptedAt} is not null`)).returning());
    return row ?? this.find(userId, id);
  }
  /** Rejected as never executed, only if nothing changed the operation since
   * `operation` was read (status, attempt and scan revision), under the
   * owner's lock; null when something did. */
  async notExecuted(operation: FundingRow, evidenceHash: string) {
    const [row] = await this.locked(operation.userId, tx => tx.update(copyFundingOperations).set({ status: "rejected", evidenceHash, updatedAt: new Date() })
      .where(and(eq(copyFundingOperations.id, operation.id), eq(copyFundingOperations.userId, operation.userId), eq(copyFundingOperations.status, "unknown"),
        sql`${copyFundingOperations.attemptedAt} is not null`, eq(copyFundingOperations.scanRevision, operation.scanRevision))).returning());
    return row ?? null;
  }
  async saveScan(operation: FundingRow, scanState: FundingScan | null) {
    const [row] = await this.db.update(copyFundingOperations).set({ scanState, scanRevision: sql`${copyFundingOperations.scanRevision} + 1`, updatedAt: new Date() })
      .where(and(eq(copyFundingOperations.id, operation.id), eq(copyFundingOperations.userId, operation.userId), eq(copyFundingOperations.scanRevision, operation.scanRevision), inArray(copyFundingOperations.status, ["unknown", "accepted"]), sql`${copyFundingOperations.attemptedAt} is not null`)).returning();
    return row ?? null;
  }
  async credit(userId: number, id: string, rawReceipt: { transactionHash: string; creditedAmount: string; fee: string }, evidenceHash: string, scanRevision: number) {
    const receipt = structuredClone(rawReceipt);
    const [row] = await this.locked(userId, tx => tx.update(copyFundingOperations).set({ ...receipt, status: "credited", evidenceHash, updatedAt: new Date() })
      .where(and(eq(copyFundingOperations.id, id), eq(copyFundingOperations.userId, userId), eq(copyFundingOperations.scanRevision, scanRevision), inArray(copyFundingOperations.status, ["unknown", "accepted"]), sql`${copyFundingOperations.attemptedAt} is not null`)).returning());
    return row ?? this.find(userId, id);
  }
}
