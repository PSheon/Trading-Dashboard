import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { copyExecutionAccounts, copyFollowerReceipts, copyFollowerLedger, copyFollowerAccountState, copyFollowerScans, users, copyLiveExecutions, copyLiveIntentProvenance, copyLiveMandates, copyLiveSignalLegs, copyLiveSourceFills, copyLiveRiskReservations, copyLiveExecutionEvidence, copyStrategyVersions, copyRiskPolicies } from '@trading-dashboard/shared/database';
import type { CopyFollowerActivityQuery } from '@trading-dashboard/shared/contracts';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';

import { mergedMemberIds } from './live/copy-live-source-planner.js';
import type { FollowerAdjustmentEvidence } from './copy-follower-adjustment.js';

type Account = { id: string; strategyId: number; network: 'testnet' | 'mainnet'; address: string; privyUserId: string };
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
      const account: Account = { id: owned.account.id, strategyId: owned.account.strategyId, network: owned.account.network, address: owned.account.address, privyUserId: owned.account.privyUserId };
      const cursor = query.before ? decode(query.before, userId, account) : null;
      const older = cursor ? or(lt(copyFollowerReceipts.providerTime, new Date(cursor.beforeTime)), and(eq(copyFollowerReceipts.providerTime, new Date(cursor.beforeTime)),
        sql`${copyFollowerReceipts.key} collate "C" < ${cursor.beforeKey}`)) : undefined;
      const rows = await tx.select().from(copyFollowerReceipts).where(and(eq(copyFollowerReceipts.accountId, accountId), older))
        .orderBy(desc(copyFollowerReceipts.providerTime), desc(sql`${copyFollowerReceipts.key} collate "C"`)).limit(query.limit + 1);
      const receipts = rows.slice(0, query.limit);
      const executionKeys = [...new Set(receipts.filter(r => r.kind === 'fill' && r.attribution === 'execution' && r.executionKey).map(r => r.executionKey!))];
      const adjustmentEvidence: FollowerAdjustmentEvidence[] = [];
      if (executionKeys.length) {
        // SQL counts serialized bytes before returning historical material.
        // Oversized evidence is omitted, never interpreted as an adjustment.
        // Fifty receipt keys maximum; at most 8 MiB across unique executions.
        const candidates = await tx.execute<{key:string}>(sql`select key from (
          select j.key, sum(octet_length(to_jsonb(j)::text)+octet_length(to_jsonb(p)::text)+octet_length(to_jsonb(m)::text)+octet_length(to_jsonb(l)::text)+octet_length(to_jsonb(f)::text)+octet_length(to_jsonb(r)::text)+octet_length(to_jsonb(e)::text)+octet_length(to_jsonb(v)::text)+octet_length(to_jsonb(policy)::text)) over(order by j.key) as bytes
          from copy_live_executions j join copy_live_intent_provenance p on p.key=j.key
          join copy_live_mandates m on m.id=p.mandate_id join copy_live_signal_legs l on l.id=p.leg_id and l.mandate_id=m.id
          join copy_live_source_fills f on f.id=l.source_fill_id join copy_live_risk_reservations r on r.key=j.key
          join copy_live_execution_evidence e on e.key=j.key join copy_strategy_versions v on v.strategy_id=j.strategy_id and v.version=r.strategy_version
          join copy_risk_policies policy on policy.version=r.policy_version
          where j.key in (${sql.join(executionKeys.map(key=>sql`${key}`),sql`,`)}) and j.user_id=${userId} and j.strategy_id=${account.strategyId} and j.network=${account.network} and j.account_address=${account.address}
            and m.user_id=j.user_id and m.strategy_id=j.strategy_id and m.account_id=${accountId} and m.network=j.network and m.account_address=j.account_address and m.owner_privy_user_id=${account.privyUserId}
            and r.user_id=j.user_id and r.strategy_id=j.strategy_id and r.account_id=m.account_id and r.network=j.network and r.account_address=j.account_address
            and e.user_id=j.user_id and e.strategy_id=j.strategy_id and e.account_id=m.account_id and e.network=j.network and e.account_address=j.account_address
            and r.state='released' and r.release_reason='verified_settlement' and l.leg='close' and l.state='settled'
            and e.settlement_proof_digest is not null and e.settlement_proof is not null
            and octet_length(p.sizing_basis::text)<=2097152 and octet_length(p.intent::text)<=16384 and octet_length(j.record::text)<=16384
            and octet_length(e.settlement_proof::text)<=2097152 and octet_length(f.raw::text)<=262144 and octet_length(f.normalized::text)<=262144
        ) bounded where bytes<=8388608`);
        const keys = candidates.rows.map(row => row.key);
        if (keys.length) {
          const original = await tx.select({journal:copyLiveExecutions,provenance:copyLiveIntentProvenance,mandate:copyLiveMandates,leg:copyLiveSignalLegs,fill:copyLiveSourceFills,reservation:copyLiveRiskReservations,evidence:copyLiveExecutionEvidence,version:copyStrategyVersions,policy:copyRiskPolicies})
            .from(copyLiveExecutions).innerJoin(copyLiveIntentProvenance,eq(copyLiveIntentProvenance.key,copyLiveExecutions.key))
            .innerJoin(copyLiveMandates,eq(copyLiveMandates.id,copyLiveIntentProvenance.mandateId)).innerJoin(copyLiveSignalLegs,and(eq(copyLiveSignalLegs.id,copyLiveIntentProvenance.legId),eq(copyLiveSignalLegs.mandateId,copyLiveMandates.id)))
            .innerJoin(copyLiveSourceFills,eq(copyLiveSourceFills.id,copyLiveSignalLegs.sourceFillId)).innerJoin(copyLiveRiskReservations,eq(copyLiveRiskReservations.key,copyLiveExecutions.key))
            .innerJoin(copyLiveExecutionEvidence,eq(copyLiveExecutionEvidence.key,copyLiveExecutions.key)).innerJoin(copyStrategyVersions,and(eq(copyStrategyVersions.strategyId,copyLiveExecutions.strategyId),eq(copyStrategyVersions.version,copyLiveRiskReservations.strategyVersion)))
            .innerJoin(copyRiskPolicies,eq(copyRiskPolicies.version,copyLiveRiskReservations.policyVersion)).where(inArray(copyLiveExecutions.key,keys));
          const memberIds = [...new Set(original.flatMap(row => mergedMemberIds(row.provenance.sizingBasis,row.fill.id)))];
          // Each source member is at most 512 KiB including normalized/raw;
          // an oversized merged batch falls back to null for merged orders.
          const boundedIds = memberIds.length<=64 ? memberIds : [];
          const eligibleMembers = boundedIds.length ? (await tx.execute<{id:string}>(sql`select id from (select f.id,sum(octet_length(to_jsonb(f)::text)) over(order by f.id) as bytes from copy_live_source_fills f where f.id in (${sql.join(boundedIds.map(id=>sql`${id}`),sql`,`)}) and octet_length(to_jsonb(f)::text)<=524288) bounded where bytes<=2097152`)).rows.map(row=>row.id) : [];
          const members = eligibleMembers.length ? await tx.select().from(copyLiveSourceFills).where(inArray(copyLiveSourceFills.id,eligibleMembers)) : [];
          const memberBytes=Buffer.byteLength(JSON.stringify(members));
          for(const row of original) {
            const ids=mergedMemberIds(row.provenance.sizingBasis,row.fill.id);
            adjustmentEvidence.push({...row,members:memberBytes<=2097152?members.filter(member=>ids.includes(member.id)):[]});
          }
        }
      }
      const components = receipts.length ? await tx.select().from(copyFollowerLedger).where(inArray(copyFollowerLedger.receiptKey, receipts.map(r => r.key))) : [];
      const [state] = await tx.select().from(copyFollowerAccountState).where(eq(copyFollowerAccountState.accountId, accountId));
      const [scan] = await tx.select().from(copyFollowerScans).where(eq(copyFollowerScans.accountId, accountId));
      // Before-only chronology is pagination, not a completeness/commit cursor.
      return { account, receipts, adjustmentEvidence, components, state: state ?? null, scan: scan ?? null, hasMore: rows.length > query.limit };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
