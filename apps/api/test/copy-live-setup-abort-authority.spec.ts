import { liveCopyMandateIntentSchema } from '@trading-dashboard/shared/contracts';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { eq, sql } from 'drizzle-orm';
import { copyLiveMandates, copyLiveSetupAborts, copyLiveSetups, copyStrategies, copyExecutionAccounts, copyLiveStrategyConfigs } from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { CopyLiveSetupAbortRepository } from '../src/copy/copy-live-setup-abort.repository.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, type TestDb } from './db-test-utils.js';

let db: TestDb, repository: CopyLiveSetupAbortRepository;
const id = '00000000-0000-4000-8000-000000000010';
const key = 'abort-authority-original-key';
beforeEach(async () => {
  db = getTestDb(); const seed = await preparationFixture(db), config = testConfig();
  const mandates = new CopyLiveMandateRepository(db, config), stops = new CopyLiveStopRepository(db, mandates);
  repository = new CopyLiveSetupAbortRepository(db, config, mandates, stops);
  await db.insert(copyLiveSetups).values({ id, userId: 1, strategyId: 9, accountId: 'account', kind: 'edit', stage: 'awaiting_consent',
    idempotencyKey: 'original-edit-request-key', leaderAddress: seed.consent.leaderAddress, sourceNetwork: 'testnet', budgetUsd: '100', settings: seed.f.strategy.settings });
});
afterAll(closeTestDb);

it('concurrent aborts establish one persistent authority and recover it after repository restart', async () => {
  const [first, second] = await Promise.all([repository.request(1, id, key), repository.request(1, id, 'other-explicit-abort-key')]);
  expect(second.id).toBe(first.id);
  expect(await db.select().from(copyLiveSetupAborts)).toHaveLength(1);
  const config = testConfig(), mandates = new CopyLiveMandateRepository(db, config);
  const restarted = new CopyLiveSetupAbortRepository(db, config, mandates, new CopyLiveStopRepository(db, mandates));
  expect(await restarted.find(1, first.id)).toMatchObject({ id: first.id, setupId: id, kind: 'edit', destination: first.ownerAddress });
  expect((await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, id)))[0]!.stage).toBe('awaiting_consent');
});

it('aborting a pending edit preserves the existing live generation and strategy', async () => {
  const before = await db.select().from(copyLiveMandates), strategies = await db.select().from(copyStrategies);
  const abort = await repository.request(1, id, key);
  expect(abort).toMatchObject({ kind: 'edit', mandateId: null, stopId: null, returnOperationId: null });
  expect(await db.select().from(copyLiveMandates)).toEqual(before);
  expect(await db.select().from(copyStrategies)).toEqual(strategies);
});

it('a foreign owner or deployment network cannot acquire or read an abort authority', async () => {
  const stranger = await insertUser(db, { privyUserId: 'did:privy:abort-other' });
  await expect(repository.request(stranger.id, id, key)).rejects.toMatchObject({ status: 404 });
  const abort = await repository.request(1, id, key);
  await expect(repository.find(stranger.id, abort.id)).rejects.toMatchObject({ status: 404 });
  await db.update(copyStrategies).set({ network: 'mainnet' }).where(eq(copyStrategies.id, 9));
  await expect(repository.request(1, id, key)).rejects.toMatchObject({ status: 404 });
});

it('persistent worker leases survive restart and fence results from a replaced holder', async () => {
  const abort = await repository.request(1, id, key);
  const first = await repository.lease(abort.id);
  expect(first?.leaseToken).toBeTruthy();
  expect(await repository.lease(abort.id)).toBeNull();
  await db.update(copyLiveSetupAborts).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(copyLiveSetupAborts.id, abort.id));
  const config = testConfig(), mandates = new CopyLiveMandateRepository(db, config);
  const restarted = new CopyLiveSetupAbortRepository(db, config, mandates, new CopyLiveStopRepository(db, mandates));
  const next = await restarted.lease(abort.id);
  expect(next!.leaseToken).not.toBe(first!.leaseToken);
  expect(await repository.transition(first!, { state: 'blocked', issue: 'stale_driver' })).toBeNull();
  await repository.release(first!);
  expect((await restarted.find(1, abort.id)).leaseToken).toBe(next!.leaseToken);
  expect(await restarted.transition(next!, { state: 'draining', issue: null })).toMatchObject({ state: 'draining', revision: abort.revision + 1 });
});

it('a drained pending edit ends only its own setup and leaves the running generation intact', async () => {
  const before = await db.select().from(copyLiveMandates), strategies = await db.select().from(copyStrategies);
  const abort = await repository.request(1, id, key), leased = (await repository.lease(abort.id))!;
  expect(await repository.finishPending(leased)).toBe(true);
  expect(await repository.find(1, abort.id)).toMatchObject({ state: 'done', returnOperationId: null, stopId: null });
  expect((await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, id)))[0]!.stage).toBe('cancelled');
  expect(await db.select().from(copyLiveMandates)).toEqual(before);
  expect(await db.select().from(copyStrategies)).toEqual(strategies);
});

it('an expired pending edit driver can be sealed only while its pinned running generation remains unchanged', async () => {
  await db.update(copyLiveSetups).set({ leaseToken: 'old-driver-token', leaseUntil: sql`now() - interval '1 second'` }).where(eq(copyLiveSetups.id, id));
  const abort = await repository.request(1, id, key), leased = (await repository.lease(abort.id))!;
  expect(await repository.finishPending(leased)).toBe(true);
  expect((await repository.find(1, abort.id)).state).toBe('done');
  expect((await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, id)))[0]).toMatchObject({ leaseToken: null, leaseUntil: null, stage: 'cancelled' });
});

it('a changed original generation prevents expired edit-driver cleanup', async () => {
  await db.update(copyLiveSetups).set({ leaseToken: 'paused-edit-driver', leaseUntil: sql`now() - interval '1 second'` }).where(eq(copyLiveSetups.id, id));
  const abort = await repository.request(1, id, key), leased = (await repository.lease(abort.id))!;
  await db.update(copyLiveMandates).set({ intentDigest: 'f'.repeat(64) });
  expect(await repository.finishPending(leased)).toBe(false);
  expect((await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, id)))[0]!.leaseToken).toBe('paused-edit-driver');
});

it('even a released driver cannot finish a pending edit against a changed pinned generation', async () => {
  const abort = await repository.request(1, id, key), leased = (await repository.lease(abort.id))!;
  await db.update(copyLiveMandates).set({ intentDigest: 'f'.repeat(64) });
  expect(await repository.finishPending(leased)).toBe(false);
});

it('a changed original account identity prevents pending edit completion without changing its generation', async () => {
  const abort = await repository.request(1, id, key), leased = (await repository.lease(abort.id))!;
  await db.update(copyExecutionAccounts).set({ privyWalletId: 'rotated-master-wallet' });
  expect(await repository.finishPending(leased)).toBe(false);
});

it('a retained authority never publishes an updated timestamp before its creation after clock rollback', async () => {
  const abort = await repository.request(1, id, key, () => Date.now() + 60_000), leased = (await repository.lease(abort.id))!;
  const next = await repository.transition(leased, { state: 'draining', issue: 'setup_abort_child_pending' });
  expect(next!.updatedAt.getTime()).toBeGreaterThanOrEqual(abort.createdAt.getTime());
});

it.each(['paused', 'active', 'stopped'] as const)('normal old-generation %s lifecycle changes do not prevent cancelling its pending edit', async state => {
  const abort = await repository.request(1, id, key), leased = (await repository.lease(abort.id))!;
  await db.update(copyLiveMandates).set({ state, revision: sql`revision + 1` });
  await db.update(copyStrategies).set({ status: state === 'paused' ? 'paused' : state === 'stopped' ? 'stopped' : 'active',
    pauseNewRisk: state !== 'active', controlRevision: sql`control_revision + 1`, stoppedAt: state === 'stopped' ? new Date() : null });
  const generations = await db.select().from(copyLiveMandates), strategies = await db.select().from(copyStrategies);
  expect(await repository.finishPending(leased)).toBe(true);
  expect(await db.select().from(copyLiveMandates)).toEqual(generations);
  expect(await db.select().from(copyStrategies)).toEqual(strategies);
});

it('changed strategy financial terms prevent pending edit cleanup', async () => {
  const abort = await repository.request(1, id, key), leased = (await repository.lease(abort.id))!;
  await db.update(copyLiveStrategyConfigs).set({ budgetUsd: '101' });
  expect(await repository.finishPending(leased)).toBe(false);
});

it('a genuinely different activated generation prevents cancelling a stale pending edit', async () => {
  const abort = await repository.request(1, id, key), leased = (await repository.lease(abort.id))!;
  const original = (await db.select().from(copyLiveMandates))[0]!;
  await db.update(copyLiveMandates).set({ state: 'expired' }).where(eq(copyLiveMandates.id, original.id));
  const intent = liveCopyMandateIntentSchema.parse({ ...original.intent, mandateId: 'different-activated-generation', nonce: original.nonce + 1 });
  await db.insert(copyLiveMandates).values({ ...original, id: intent.mandateId, idempotencyKey: 'different-generation-original-key',
    nonce: intent.nonce, intent, intentDigest: mandateDigest(intent), consentDigest: 'd'.repeat(64) });
  expect(await repository.finishPending(leased)).toBe(false);
  expect((await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, id)))[0]!.stage).toBe('awaiting_consent');
});
