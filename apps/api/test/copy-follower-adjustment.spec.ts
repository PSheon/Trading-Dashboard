import { expect, it } from 'vitest';
import { CopyFollowerActivityService } from '../src/copy/copy-follower-activity.service.js';
import type { CopyFollowerActivityRepository } from '../src/copy/copy-follower-activity.repository.js';
import { copyFollowerActivityItemSchema } from '@trading-dashboard/shared/contracts';
import { adjustmentExample } from './copy-follower-adjustment-test-utils.js';
it('exposes the verified original partial request separately from planned full close and actual receipt size', async () => {
  const e = adjustmentExample(),
    page = {
      account: e.account,
      receipts: [e.receipt],
      components: [],
      state: null,
      scan: null,
      hasMore: false,
      adjustmentEvidence: [e.row],
    };
  const service = new CopyFollowerActivityService({
    getOwnedPage: async () => page,
  } as unknown as CopyFollowerActivityRepository);
  expect((await service.get(1, 'account', {})).items[0]).toMatchObject({
    kind: 'fill',
    size: '0.12',
    adjustment: {
      requestedFraction: '0.25',
      requestedSize: '0.03',
      plannedSize: '0.12',
      reason: 'minimum_reduce_full_close',
      admittedAt: e.row.provenance.admittedAt.toISOString(),
    },
  });
});
it('allows optional nullable history adjustment on the public fill contract', () => {
  const e = adjustmentExample();
  expect(
    copyFollowerActivityItemSchema.safeParse({
      kind: 'fill',
      key: e.receipt.key,
      coin: 'BTC',
      time: e.receipt.providerTime.toISOString(),
      tradingCashDelta: '0',
      attribution: 'execution',
      executionKey: e.receipt.executionKey,
      tid: '124',
      oid: '11',
      side: 'A',
      size: '0.12',
      price: '100',
      realizedPnl: '0',
      exchangeFee: '0',
      builderFee: '0',
      adjustment: null,
    }).success,
  ).toBe(true);
});
import {
  originalFollowerAdjustment,
  type FollowerAdjustmentEvidence,
} from '../src/copy/copy-follower-adjustment.js';
function project(e = adjustmentExample()) {
  return originalFollowerAdjustment(
    {
      userId: e.userId,
      account: e.account,
      receipt: {
        key: e.receipt.key,
        digest: e.receipt.digest,
        executionKey: e.receipt.executionKey,
        oid: '11',
        coin: 'BTC',
        side: 'A',
      },
    },
    e.row as unknown as FollowerAdjustmentEvidence,
  );
}
it('uses the original carry/lot request instead of labelling raw fraction times current holdings', () => {
  expect(project(adjustmentExample('0.12', '0.02'))).toMatchObject({
    requestedFraction: '0.25',
    requestedSize: '0.04',
    plannedSize: '0.12',
  });
});
it('validates canonical members and uses the original combined reduction fraction for a merged order', () => {
  expect(project(adjustmentExample('0.12', '0', true))).toMatchObject({
    requestedFraction: '0.4375',
    requestedSize: '0.05',
    plannedSize: '0.12',
  });
  const e = adjustmentExample('0.12', '0', true);
  e.row.members = [];
  expect(project(e)).toBeNull();
});
it('keeps an ordinary partial plan and a carry-requested full close without claiming an adjustment', () => {
  expect(project(adjustmentExample('1', '0'))).toBeNull();
  expect(project(adjustmentExample('0.12', '0.12'))).toBeNull();
});
it.each([
  'owner',
  'network',
  'account',
  'generation',
  'fingerprint',
  'signedAction',
  'originalQuote',
  'originalSource',
  'proof',
  'admission',
  'release',
  'receipt',
] as const)(
  'returns null for unproven %s without altering booked history',
  async (kind) => {
    const e = adjustmentExample();
    if (kind === 'owner') e.userId = 2;
    if (kind === 'network') e.account.network = 'mainnet' as 'testnet';
    if (kind === 'account') e.account.id = 'other';
    if (kind === 'generation') e.row.reservation.strategyVersion++;
    if (kind === 'fingerprint') e.row.provenance.fingerprint = 'f'.repeat(64);
    if (kind === 'signedAction')
      e.row.journal.record.action.orders[0]!.s = '0.5';
    if (kind === 'originalQuote')
      (
        e.row.provenance.sizingBasis.basis.quote as { midPrice: string }
      ).midPrice = '1000';
    if (kind === 'originalSource')
      e.row.fill.leaderAddress = `0x${'55'.repeat(20)}`;
    if (kind === 'proof') e.row.evidence.settlementProofDigest = 'f'.repeat(64);
    if (kind === 'admission') e.row.provenance.admittedAt = new Date(0);
    if (kind === 'release') e.row.reservation.state = 'unknown';
    if (kind === 'receipt') e.receipt.digest = 'f'.repeat(64);
    expect(project(e)).toBeNull();
  },
);
it('retains valid booked activity with null explanation when optional original history is missing', async () => {
  const e = adjustmentExample(),
    page = {
      account: e.account,
      receipts: [e.receipt],
      components: [],
      state: null,
      scan: null,
      hasMore: false,
      adjustmentEvidence: [],
    };
  const service = new CopyFollowerActivityService({
    getOwnedPage: async () => page,
  } as unknown as CopyFollowerActivityRepository);
  expect((await service.get(1, 'account', {})).items[0]).toMatchObject({
    kind: 'fill',
    size: '0.12',
    tradingCashDelta: '0',
    adjustment: null,
  });
});
it('planned size may exceed the actual partial receipt quantity but adjustment needs execution attribution', () => {
  const e = adjustmentExample(),
    item = {
      kind: 'fill',
      key: e.receipt.key,
      coin: 'BTC',
      time: e.receipt.providerTime.toISOString(),
      tradingCashDelta: '0',
      attribution: 'execution',
      executionKey: e.receipt.executionKey,
      tid: '124',
      oid: '11',
      side: 'A',
      size: '0.03',
      price: '100',
      realizedPnl: '0',
      exchangeFee: '0',
      builderFee: '0',
      adjustment: project(e),
    };
  expect(copyFollowerActivityItemSchema.safeParse(item).success).toBe(true);
  expect(
    copyFollowerActivityItemSchema.safeParse({
      ...item,
      attribution: 'account',
      executionKey: null,
    }).success,
  ).toBe(false);
});
