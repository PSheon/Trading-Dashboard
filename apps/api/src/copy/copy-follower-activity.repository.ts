import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { copyExecutionAccounts, copyFollowerReceipts, copyFollowerLedger, copyFollowerAccountState, copyFollowerScans, users } from '@trading-dashboard/shared/database';
import type { CopyFollowerActivityQuery } from '@trading-dashboard/shared/contracts';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';

type Account = { id: string; strategyId: number; network: 'testnet' | 'mainnet'; address: string };
const cursorSchema = z.object({ v: z.literal(1), userId: z.number().int().positive(), accountId: z.string().min(1).max(128), network: z.enum(['testnet', 'mainnet']),
  accountAddress: z.string().regex(/^0x[0-9a-f]{40}$/), beforeTime: z.string().datetime(), beforeKey: z.string().min(1).max(350) }).strict();
export function followerActivityCursor(userId: number, account: Account, row: { providerTime: Date; key: string }): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse({ v: 1, userId, accountId: account.id, network: account.network, accountAddress: account.address, beforeTime: row.providerTime.toISOString(), beforeKey: row.key }))).toString('base64url');
}
function decode(value: string, userId: number, account: Account) {
  try {
    const bytes = Buffer.from(value, 'base64url'); if (bytes.toString('base64url') !== value) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (cursor.userId !== userId || cursor.accountId !== account.id || cursor.network !== account.network || cursor.accountAddress !== account.address ||
      !cursor.beforeKey.startsWith(`${account.network}:${account.address}:`)) throw new Error();
    return cursor;
  } catch { throw new BadRequestException('Invalid follower history cursor'); }
}

@Injectable()
export class CopyFollowerActivityRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  getOwnedPage(userId: number, accountId: string, query: CopyFollowerActivityQuery) {
    return this.db.transaction(async tx => {
      const [owned] = await tx.select({ account: copyExecutionAccounts }).from(copyExecutionAccounts).innerJoin(users, eq(users.id, copyExecutionAccounts.userId))
        .where(and(eq(copyExecutionAccounts.id, accountId), eq(copyExecutionAccounts.userId, userId), isNull(users.disabledAt), eq(copyExecutionAccounts.privyUserId, users.privyUserId)));
      if (!owned?.account.address) throw new NotFoundException('Execution account not found');
      const account: Account = { id: owned.account.id, strategyId: owned.account.strategyId, network: owned.account.network, address: owned.account.address };
      const cursor = query.before ? decode(query.before, userId, account) : null;
      const older = cursor ? or(lt(copyFollowerReceipts.providerTime, new Date(cursor.beforeTime)), and(eq(copyFollowerReceipts.providerTime, new Date(cursor.beforeTime)),
        sql`${copyFollowerReceipts.key} collate "C" < ${cursor.beforeKey}`)) : undefined;
      const rows = await tx.select().from(copyFollowerReceipts).where(and(eq(copyFollowerReceipts.accountId, accountId), older))
        .orderBy(desc(copyFollowerReceipts.providerTime), desc(sql`${copyFollowerReceipts.key} collate "C"`)).limit(query.limit + 1);
      const receipts = rows.slice(0, query.limit);
      const components = receipts.length ? await tx.select().from(copyFollowerLedger).where(inArray(copyFollowerLedger.receiptKey, receipts.map(r => r.key))) : [];
      const [state] = await tx.select().from(copyFollowerAccountState).where(eq(copyFollowerAccountState.accountId, accountId));
      const [scan] = await tx.select().from(copyFollowerScans).where(eq(copyFollowerScans.accountId, accountId));
      // Before-only chronology is pagination, not a completeness/commit cursor.
      return { account, receipts, components, state: state ?? null, scan: scan ?? null, hasMore: rows.length > query.limit };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
