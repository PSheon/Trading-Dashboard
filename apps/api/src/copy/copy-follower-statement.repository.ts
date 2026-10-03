import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { copyExecutionAccounts, copyFollowerReceipts, copyFollowerLedger, copyFollowerAccountState, copyFollowerScans, users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

@Injectable()
export class CopyFollowerStatementRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  getOwnedSnapshot(userId: number, accountId: string) {
    return this.db.transaction(async tx => {
      const [owned] = await tx.select({ account: copyExecutionAccounts }).from(copyExecutionAccounts)
        .innerJoin(users, eq(users.id, copyExecutionAccounts.userId)).where(and(eq(copyExecutionAccounts.id, accountId),
          eq(copyExecutionAccounts.userId, userId), isNull(users.disabledAt), eq(copyExecutionAccounts.privyUserId, users.privyUserId)));
      if (!owned?.account.address) throw new NotFoundException("Execution account not found");
      const totals = await tx.select({ component: copyFollowerLedger.component, amount: sql<string>`sum(${copyFollowerLedger.amount})::text` }).from(copyFollowerLedger)
          .innerJoin(copyFollowerReceipts, eq(copyFollowerReceipts.key, copyFollowerLedger.receiptKey))
          .where(eq(copyFollowerReceipts.accountId, accountId)).groupBy(copyFollowerLedger.component);
      const [count] = await tx.select({ value: sql<string>`count(*)::text` }).from(copyFollowerReceipts).where(eq(copyFollowerReceipts.accountId, accountId));
      const receipts = await tx.select().from(copyFollowerReceipts).where(eq(copyFollowerReceipts.accountId, accountId)).orderBy(desc(copyFollowerReceipts.providerTime), desc(copyFollowerReceipts.key)).limit(50);
      const [state] = await tx.select().from(copyFollowerAccountState).where(eq(copyFollowerAccountState.accountId, accountId));
      const [scan] = await tx.select().from(copyFollowerScans).where(eq(copyFollowerScans.accountId, accountId));
      return { account: { ...owned.account, address: owned.account.address }, totals, receiptCount: count.value, receipts, state, scan };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
}
