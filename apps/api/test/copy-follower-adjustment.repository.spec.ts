import { afterAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  users,
  copyExecutionAccounts,
  copyLiveMandates,
  copyStrategyVersions,
  copyLiveExecutions,
  copyLiveRiskReservations,
  copyLiveExecutionEvidence,
  copyLiveSourceFills,
  copyLiveSignalLegs,
  copyLiveIntentProvenance,
  copyFollowerReceipts,
} from '@trading-dashboard/shared/database';
import { getTestDb, closeTestDb } from './db-test-utils.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { adjustmentExample } from './copy-follower-adjustment-test-utils.js';
import { digest } from '../src/copy/copy-live-mandate-evidence.js';
import { CopyFollowerActivityRepository } from '../src/copy/copy-follower-activity.repository.js';
import { CopyFollowerActivityService } from '../src/copy/copy-follower-activity.service.js';
const db = getTestDb(),
  repository = new CopyFollowerActivityRepository(db),
  service = new CopyFollowerActivityService(repository);
afterAll(closeTestDb);
let example: ReturnType<typeof adjustmentExample>;
async function install(merged = false) {
  await preparationFixture(db);
  example = adjustmentExample('0.12', '0', merged);
  const { row: r } = example,
    admitted = r.provenance.admittedAt;
  await db
    .update(users)
    .set({
      privyUserId: example.account.privyUserId,
      embeddedWalletAddress: r.mandate.ownerAddress,
    });
  await db
    .update(copyExecutionAccounts)
    .set({ privyUserId: example.account.privyUserId });
  const intent = { ...r.mandate.intent, executionWalletId: 'wallet-row' };
  await db
    .update(copyLiveMandates)
    .set({
      ...r.mandate,
      intent,
      intentDigest: digest(intent),
      executionWalletId: 'wallet-row',
      consentExpiresAt: new Date(r.mandate.consentExpiresAt),
      expiresAt: new Date(r.mandate.expiresAt),
      createdAt: new Date(r.mandate.createdAt),
      updatedAt: new Date(r.mandate.updatedAt),
    } as never);
  await db
    .update(copyStrategyVersions)
    .set({ settings: r.version.settings })
    .where(eq(copyStrategyVersions.version, 2));
  await db
    .insert(copyLiveExecutions)
    .values({ ...r.journal, updatedAt: new Date(r.journal.record.updatedAt) });
  await db
    .insert(copyLiveRiskReservations)
    .values({
      ...r.reservation,
      coin: r.fill.coin,
      dex: r.provenance.intent.market.dex,
      asset: r.provenance.intent.asset,
      createdAt: admitted,
      updatedAt: new Date(r.journal.record.updatedAt),
      expiresAt: new Date(r.reservation.payload.expiresAt),
      attemptedAt: admitted,
    } as never);
  await db
    .insert(copyLiveExecutionEvidence)
    .values({
      ...r.evidence,
      createdAt: admitted,
      updatedAt: new Date(r.journal.record.updatedAt),
    } as never);
  await db.insert(copyLiveSourceFills).values(r.fill as never);
  if (r.members.length)
    await db.insert(copyLiveSourceFills).values(r.members as never);
  await db
    .insert(copyLiveSignalLegs)
    .values({ ...r.leg, createdAt: admitted, updatedAt: admitted } as never);
  await db.insert(copyLiveIntentProvenance).values(r.provenance as never);
  await db.insert(copyFollowerReceipts).values(example.receipt as never);
}
beforeEach(() => install());
it('loads only owned original material and returns verified planned full close without exposing proof', async () => {
  const page = await repository.getOwnedPage(1, 'account', { limit: 50 });
  expect(page.adjustmentEvidence).toHaveLength(1);
  const publicPage = await service.get(1, 'account', {});
  expect(publicPage.items[0]).toMatchObject({
    kind: 'fill',
    size: '0.12',
    adjustment: {
      requestedFraction: '0.25',
      requestedSize: '0.03',
      plannedSize: '0.12',
      reason: 'minimum_reduce_full_close',
    },
  });
  expect(JSON.stringify(publicPage)).not.toMatch(
    /settlementProof|sizingBasis|ownerPrivyUserId|authorization|intentDigest/,
  );
  await expect(
    repository.getOwnedPage(2, 'account', { limit: 50 }),
  ).rejects.toThrow('Execution account not found');
});
it.each([
  'mandateOwner',
  'network',
  'accountAddress',
  'generation',
  'held',
  'oversizedBasis',
  'oversizedProof',
  'aggregateBytes',
] as const)(
  'omits %s material while retaining booked activity',
  async (kind) => {
    const key = example.row.journal.key;
    if (kind === 'mandateOwner')
      await db
        .update(copyLiveMandates)
        .set({ ownerPrivyUserId: 'did:another-owner' });
    if (kind === 'network')
      await db.update(copyLiveExecutions).set({ network: 'mainnet' });
    if (kind === 'accountAddress')
      await db
        .update(copyLiveRiskReservations)
        .set({ accountAddress: `0x${'66'.repeat(20)}` });
    if (kind === 'generation')
      await db.update(copyLiveRiskReservations).set({ strategyVersion: 3 });
    if (kind === 'held')
      await db
        .update(copyLiveRiskReservations)
        .set({
          state: 'unknown',
          releaseReason: null,
          releaseEvidenceDigest: null,
        });
    if (kind === 'oversizedBasis')
      await db
        .update(copyLiveIntentProvenance)
        .set({ sizingBasis: { oversized: 'x'.repeat(2097153) } });
    if (kind === 'oversizedProof')
      await db
        .update(copyLiveExecutionEvidence)
        .set({ settlementProof: { oversized: 'x'.repeat(2097153) } });
    if (kind === 'aggregateBytes')
      await db
        .update(copyStrategyVersions)
        .set({
          settings: {
            ...example.row.version.settings,
            oversized: 'x'.repeat(8388608),
          } as never,
        });
    const page = await repository.getOwnedPage(1, 'account', { limit: 50 });
    expect(page.adjustmentEvidence).toHaveLength(0);
    expect(page.receipts[0]?.executionKey).toBe(key);
    expect((await service.get(1, 'account', {})).items[0]).toMatchObject({
      kind: 'fill',
      size: '0.12',
      tradingCashDelta: '0',
      adjustment: null,
    });
  },
);
it('loads bounded corrupted proof but fails closed only on optional explanation', async () => {
  await db
    .update(copyLiveExecutionEvidence)
    .set({ settlementProofDigest: 'f'.repeat(64) });
  expect(
    (await repository.getOwnedPage(1, 'account', { limit: 50 }))
      .adjustmentEvidence,
  ).toHaveLength(1);
  expect((await service.get(1, 'account', {})).items[0]).toMatchObject({
    kind: 'fill',
    size: '0.12',
    adjustment: null,
  });
});

it('loads exact merged members and omits explanation if a member exceeds its SQL byte cap', async () => {
  await install(true);
  let page = await repository.getOwnedPage(1, 'account', { limit: 50 });
  expect(page.adjustmentEvidence[0]?.members).toHaveLength(1);
  expect((await service.get(1, 'account', {})).items[0]).toMatchObject({
    adjustment: {
      requestedFraction: '0.4375',
      requestedSize: '0.05',
      plannedSize: '0.12',
    },
  });
  await db
    .update(copyLiveSourceFills)
    .set({ raw: { oversized: 'x'.repeat(524289) } })
    .where(eq(copyLiveSourceFills.id, example.row.members[0]!.id));
  page = await repository.getOwnedPage(1, 'account', { limit: 50 });
  expect(page.adjustmentEvidence[0]?.members).toHaveLength(0);
  expect((await service.get(1, 'account', {})).items[0]).toMatchObject({
    size: '0.12',
    adjustment: null,
  });
});
