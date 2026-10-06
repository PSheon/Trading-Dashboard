import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CopyLiveSetupRepository } from '../src/copy/copy-live-setup.repository.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, insertUser, type TestDb } from './db-test-utils.js';

// The setup repository's own SQL: which starts a new start ends first
// (abandonedStarts), and what ending a start does (endStart) with a
// generation that ran and with a deposit that was sent.
let db: TestDb, repository: CopyLiveSetupRepository, seed: Awaited<ReturnType<typeof preparationFixture>>;
const leader = `0x${'44'.repeat(20)}`, other = `0x${'45'.repeat(20)}`;
let n = 0;
/** What a confirmed setup carries (copy_live_setups_consent_check). */
const CONFIRMED = { consentDigest: 'c'.repeat(64), intentDigest: 'd'.repeat(64), confirmedAt: new Date(now), setupDeadline: new Date(now + 86_400_000) };
async function setup(values: Partial<typeof schema.copyLiveSetups.$inferInsert> = {}) {
  n++;
  const unconfirmed = ['provisioning', 'awaiting_consent', 'failed', 'expired', 'cancelled'].includes(values.stage ?? 'awaiting_consent');
  values = unconfirmed ? values : { ...CONFIRMED, ...values };
  const [row] = await db.insert(schema.copyLiveSetups).values({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, userId: 1, strategyId: 9, accountId: 'account', kind: 'start',
    idempotencyKey: `setup-repository-key-${String(n).padStart(4, '0')}`, stage: 'awaiting_consent', leaderAddress: leader, sourceNetwork: 'testnet', budgetUsd: '100', settings: {}, ...values }).returning();
  return row!;
}
async function deposit(status: 'prepared' | 'accepted', liveSetupId: string) {
  const [row] = await db.insert(schema.copyFundingOperations).values({ id: `11111111-1111-4111-8111-${String(++n).padStart(12, '0')}`, userId: 1, accountId: 'account', strategyId: 9,
    idempotencyKey: `setup-repository-fund-${n}`, network: 'testnet', address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '100', nonce: now + n, status, liveSetupId,
    ...(status === 'accepted' ? { claimedAt: new Date(now), attemptedAt: new Date(now), evidenceHash: 'a'.repeat(64) } : {}) }).returning();
  return row!;
}
const strategy = async () => (await db.select().from(schema.copyStrategies).where(eq(schema.copyStrategies.id, 9)))[0]!;
const operation = async (id: string) => (await db.select().from(schema.copyFundingOperations).where(eq(schema.copyFundingOperations.id, id)))[0]!;

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db); repository = new CopyLiveSetupRepository(db);
  await db.update(schema.copyStrategies).set({ status: 'paused', pauseNewRisk: true });
});
afterAll(async () => { await closeTestDb(); });

/** A setup on a strategy of its own (one unfinished setup per strategy). */
async function apart(values: Partial<typeof schema.copyLiveSetups.$inferInsert> = {}) {
  const id = 100 + n;
  // Its own leader too (one open testnet copy per owner and leader); the
  // setup's leader is the one abandonedStarts looks for.
  await db.insert(schema.copyStrategies).values({ id, userId: values.userId ?? 1, mode: 'testnet', leaderAddress: `0x${'7'.repeat(37)}${String(id).padStart(3, '0')}`, allocated: '0', cash: '0', status: 'paused', activatedAt: new Date(now) });
  return setup({ strategyId: id, accountId: null, ...values });
}

describe('abandonedStarts', () => {
  it("is this owner's starts for this leader that never got a consent, or ended without one running", async () => {
    const unconfirmed = [await apart({ stage: 'provisioning' }), await apart({ stage: 'awaiting_consent' })];
    const ended = [await apart({ stage: 'failed', issue: 'setup_account_mode_failed' }), await apart({ stage: 'expired', issue: 'setup_expired' })];
    // Not abandoned: still going, running, already ended for good.
    for (const stage of ['consented', 'funding_submitted', 'funded', 'mode_set', 'agent_active', 'builder_ready', 'running', 'cancelled'] as const) await apart({ stage });
    // Not this leader, not a start, not this owner.
    await apart({ leaderAddress: other });
    await apart({ kind: 'edit' });
    const stranger = await insertUser(db, { privyUserId: 'did:privy:setup-repository-other' });
    await apart({ userId: stranger.id });
    const found = await repository.abandonedStarts(db, 1, leader, 'testnet');
    expect(found.map(row => row.id).sort()).toEqual([...unconfirmed, ...ended].map(row => row.id).sort());
  });
});

describe('endStart', () => {
  it('cancels its never-sent deposit and stops the paused strategy when no generation ever ran', async () => {
    await db.delete(schema.copyLiveMandates);
    const row = await setup();
    const reserved = await deposit('prepared', row.id);
    expect(await repository.endStart(db, 1, { ...row, fundingOperationId: reserved.id })).toBe(true);
    expect((await operation(reserved.id)).status).toBe('cancelled');
    expect(await strategy()).toMatchObject({ status: 'stopped', pauseNewRisk: true });
  });

  it('leaves the strategy running when a generation is active (it stops only an empty start)', async () => {
    // preparationFixture's generation is active.
    const row = await setup({ stage: 'failed' });
    expect(await repository.endStart(db, 1, row)).toBe(false);
    expect((await strategy()).status).toBe('paused');
    expect((await db.select().from(schema.copyLiveMandates))[0]!.state).toBe('active');
  });

  it('keeps a deposit that was sent (accepted) and still stops the paused strategy: what arrived is returned from the portfolio', async () => {
    await db.delete(schema.copyLiveMandates);
    const row = await setup({ stage: 'expired', issue: 'setup_deposit_uncredited' });
    const sent = await deposit('accepted', row.id);
    expect(await repository.endStart(db, 1, { ...row, fundingOperationId: sent.id })).toBe(true);
    expect((await operation(sent.id)).status).toBe('accepted');
    expect((await strategy()).status).toBe('stopped');
  });

  it("doesn't stop the strategy while another of its setups is still going", async () => {
    await db.delete(schema.copyLiveMandates);
    const ended = await setup({ stage: 'failed' });
    await setup({ stage: 'funding_submitted' });
    expect(await repository.endStart(db, 1, ended)).toBe(false);
    expect((await strategy()).status).toBe('paused');
  });
});
