import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { and, desc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { copyStrategies, referralAttributions, referralClaims, referralCodes, referralLedger, referralPolicies, users } from '@trading-dashboard/shared/database';
import { AppConfig } from '../config/app-config.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import { isReturningIdentity } from '../users/deletion-markers.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import { lockCopyUser } from '../copy/copy-user-lock.js';
import { claimIntentHash } from './referral-ledger.js';
import type { ReferralCursor } from './referral.service.js';

type ClaimRow = typeof referralClaims.$inferSelect;
type Page = { cursor: ReferralCursor | null; limit: number };
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const cursor = (at: Date, id: string) => Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
const claimWire = (row: ClaimRow) => ({ id: row.id, idempotencyKey: row.key, amountUnits: row.amountUnits, destination: row.destination,
  network: row.network, token: row.token, status: row.status, policyVersion: row.policyVersion, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
function originalClaim(row: ClaimRow, userId: number) {
  if (row.userId !== userId || row.requestHash !== claimIntentHash({ id: row.id, ownerId: String(userId), key: row.key, destination: row.destination,
    amountUnits: row.amountUnits, network: row.network, token: row.token })) throw new ServiceUnavailableException('Referral claim requires reconciliation');
  return claimWire(row);
}
const copying = sql<boolean>`exists(select 1 from ${copyStrategies} where ${copyStrategies.userId} = ${referralAttributions.referredUserId} and ${copyStrategies.status} <> 'stopped')`;

@Injectable()
export class ReferralRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, @Optional() private readonly config?: AppConfig) {}
  private async lock(tx: DbTransaction, userId: number) {
    await lockCopyUser(tx, userId);
    const [row] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!row || row.disabledAt) throw new NotFoundException('Referral owner not found');
    return row;
  }
  private async policy(tx: DbTransaction) {
    // Attribution can operate before commercial terms exist. This immutable
    // version grants no financial entitlement and carries no assumed rate.
    await tx.insert(referralPolicies).values({ version: 'referral-attribution-v1', enabled: false, rewardBps: null,
      minClaimUnits: null, treasuryAddress: null, effectiveFrom: new Date(0), bindWindowSeconds: 1800 }).onConflictDoNothing();
    const [row] = await tx.select().from(referralPolicies).where(and(lte(referralPolicies.effectiveFrom, sql`now()`),
      or(isNull(referralPolicies.effectiveUntil), sql`${referralPolicies.effectiveUntil} > now()`)))
      .orderBy(desc(referralPolicies.effectiveFrom), desc(referralPolicies.createdAt), desc(referralPolicies.version)).limit(1);
    if (!row) throw new ServiceUnavailableException('Referral policy unavailable');
    return row;
  }
  private async ensureCode(tx: DbTransaction, userId: number) {
    const [existing] = await tx.select().from(referralCodes).where(and(eq(referralCodes.userId, userId), eq(referralCodes.isCurrent, true)));
    if (existing) return existing;
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await tx.insert(referralCodes).values({ id: randomUUID(), userId, code: randomBytes(8).toString('hex').toUpperCase(), kind: 'default', isCurrent: true }).onConflictDoNothing().returning();
      if (row) return row;
    }
    throw new ServiceUnavailableException('Unable to allocate referral code');
  }
  async overview(userId: number) {
    return this.db.transaction(async tx => {
      const user = await this.lock(tx, userId), code = await this.ensureCode(tx, userId), policy = await this.policy(tx);
      const [attribution] = await tx.select().from(referralAttributions).where(eq(referralAttributions.referredUserId, userId));
      const totals = await tx.select({ bucket: referralLedger.bucket, amount: sql<string>`sum(${referralLedger.amountUnits}::numeric)::text` })
        .from(referralLedger).where(eq(referralLedger.userId, userId)).groupBy(referralLedger.bucket);
      const balances = { earned: '0', available: '0', pending: '0', claimed: '0' };
      for (const row of totals) balances[row.bucket] = row.amount;
      if (Object.values(balances).some(v => !/^(0|[1-9][0-9]{0,38})$/.test(v) || BigInt(v) > (1n << 128n) - 1n)
        || BigInt(balances.earned) !== BigInt(balances.available) + BigInt(balances.pending) + BigInt(balances.claimed)) {
        throw new ServiceUnavailableException('Referral balances require reconciliation');
      }
      // An identity that deleted an account within the retention window can't
      // bind again (docs/account-deletion.md): no window to show either.
      const returning = !attribution && await isReturningIdentity(tx, user, this.config);
      return { code: code.code, referred: Boolean(attribution), bindOpenUntil: attribution || returning ? null : new Date(user.createdAt.getTime() + policy.bindWindowSeconds * 1000).toISOString(),
        hasWallet: Boolean(user.embeddedWalletAddress), policy: { version: policy.version, enabled: policy.enabled, rewardBps: policy.rewardBps,
          minClaimUnits: policy.minClaimUnits, bindWindowSeconds: policy.bindWindowSeconds }, balances };
    });
  }
  async check(code: string): Promise<boolean> {
    const [row] = await this.db.select({ id: referralCodes.id }).from(referralCodes).innerJoin(users, eq(users.id, referralCodes.userId))
      .where(and(eq(referralCodes.code, code), isNull(users.disabledAt))).limit(1);
    return Boolean(row);
  }
  async setCode(userId: number, code: string) {
    return this.db.transaction(async tx => {
      await this.lock(tx, userId);
      const [existing] = await tx.select().from(referralCodes).where(eq(referralCodes.code, code));
      if (existing && existing.userId !== userId) throw conflict('referral_code_taken', 'This code is already assigned');
      if (existing?.isCurrent) return { code };
      await tx.update(referralCodes).set({ isCurrent: false }).where(and(eq(referralCodes.userId, userId), eq(referralCodes.isCurrent, true)));
      if (existing) await tx.update(referralCodes).set({ isCurrent: true }).where(eq(referralCodes.id, existing.id));
      else {
        const [inserted] = await tx.insert(referralCodes).values({ id: randomUUID(), userId, code, kind: 'custom', isCurrent: true }).onConflictDoNothing().returning();
        if (!inserted) throw conflict('referral_code_taken', 'This code is already assigned');
      }
      return { code };
    });
  }
  async bind(userId: number, code: string) {
    return this.db.transaction(async tx => {
      const [target] = await tx.select().from(referralCodes).where(eq(referralCodes.code, code));
      if (!target) throw new NotFoundException('Referral code not found');
      if (target.userId === userId) throw conflict('referral_self', 'You cannot refer yourself');
      // Deterministic multi-user advisory/row ordering prevents mutual binds
      // from deadlocking and serializes against owner deletion/disable.
      const locked = new Map<number, typeof users.$inferSelect>();
      for (const id of [userId, target.userId].sort((a, b) => a - b)) locked.set(id, await this.lock(tx, id));
      const [original] = await tx.select().from(referralAttributions).where(eq(referralAttributions.referredUserId, userId));
      if (original) {
        if (original.referrerUserId !== target.userId) throw conflict('referral_already_bound', 'Your referrer is already bound');
        return { bound: true as const, boundAt: original.boundAt.toISOString() };
      }
      const policy = await this.policy(tx);
      const nowResult = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
      const now = new Date(nowResult.rows[0]!.now), user = locked.get(userId)!;
      if (now.getTime() < user.createdAt.getTime() || now.getTime() >= user.createdAt.getTime() + policy.bindWindowSeconds * 1000)
        throw conflict('referral_bind_closed', 'The referral binding window has closed');
      // Deleting an account and signing up again opens no new window: a
      // returning identity (keyed hash, retention window) can't bind, so an
      // inviter can't re-invite the same person for credit.
      if (await isReturningIdentity(tx, user, this.config)) throw conflict('referral_bind_closed', 'The referral binding window has closed');
      const [row] = await tx.insert(referralAttributions).values({ id: randomUUID(), referredUserId: userId, referrerUserId: target.userId,
        codeId: target.id, policyVersion: policy.version, boundAt: now }).returning();
      return { bound: true as const, boundAt: row!.boundAt.toISOString() };
    });
  }
  async friends(userId: number, page: Page) {
    const where = eq(referralAttributions.referrerUserId, userId);
    const before = page.cursor ? or(lt(referralAttributions.boundAt, page.cursor.at), and(eq(referralAttributions.boundAt, page.cursor.at), lt(referralAttributions.id, page.cursor.id))) : undefined;
    const [stats] = await this.db.select({ invited: sql<number>`count(*)::int`, copying: sql<number>`count(*) filter(where ${copying})::int` }).from(referralAttributions).where(where);
    const rows = await this.db.select({ id: referralAttributions.id, joinedAt: users.createdAt, boundAt: referralAttributions.boundAt, copying,
      copyingModes: sql<Array<'paper' | 'testnet'>>`array(select distinct ${copyStrategies.mode} from ${copyStrategies} where ${copyStrategies.userId} = ${referralAttributions.referredUserId} and ${copyStrategies.status} <> 'stopped')` })
      .from(referralAttributions).innerJoin(users, eq(users.id, referralAttributions.referredUserId)).where(and(where, before))
      .orderBy(desc(referralAttributions.boundAt), desc(referralAttributions.id)).limit(page.limit + 1);
    const items = rows.slice(0, page.limit), last = items.at(-1);
    return { invited: stats?.invited ?? 0, copying: stats?.copying ?? 0,
      items: items.map(r => ({ id: r.id, label: `Friend ${r.id.slice(0, 8)}`, joinedAt: r.joinedAt.toISOString(), copying: r.copying, copyingModes: r.copyingModes })),
      nextCursor: rows.length > page.limit && last ? cursor(last.boundAt, last.id) : null };
  }
  async claims(userId: number, page: Page) {
    const before = page.cursor ? or(lt(referralClaims.createdAt, page.cursor.at), and(eq(referralClaims.createdAt, page.cursor.at), lt(referralClaims.id, page.cursor.id))) : undefined;
    const rows = await this.db.select().from(referralClaims).where(and(eq(referralClaims.userId, userId), before))
      .orderBy(desc(referralClaims.createdAt), desc(referralClaims.id)).limit(page.limit + 1);
    const items = rows.slice(0, page.limit), last = items.at(-1);
    return { items: items.map(row => originalClaim(row, userId)), nextCursor: rows.length > page.limit && last ? cursor(last.createdAt, last.id) : null };
  }
  async findClaim(userId: number, id: string) {
    const [row] = await this.db.select().from(referralClaims).where(and(eq(referralClaims.userId, userId), eq(referralClaims.id, id)));
    if (!row) throw new NotFoundException('Referral claim not found');
    return originalClaim(row, userId);
  }
  async claim(userId: number, key: string) {
    return this.db.transaction(async tx => {
      await this.lock(tx, userId);
      const [existing] = await tx.select().from(referralClaims).where(and(eq(referralClaims.userId, userId), eq(referralClaims.key, key)));
      if (existing) {
        return originalClaim(existing, userId);
      }
      // No trusted treasury collection/payout adapter is registered. Even an
      // enabled policy or ledger row cannot turn this path into a payment.
      throw new ServiceUnavailableException({ code: 'referral_payout_unavailable', message: 'Confirmed collection and payout integration is not available' });
    });
  }
  async findClaimByKey(userId: number, key: string) {
    const [row] = await this.db.select().from(referralClaims).where(and(eq(referralClaims.userId, userId), eq(referralClaims.key, key)));
    if (!row) throw new NotFoundException('Referral claim not found');
    return originalClaim(row, userId);
  }
}
