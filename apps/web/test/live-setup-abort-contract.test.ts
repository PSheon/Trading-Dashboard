import { describe, expect, it } from 'vitest';
import { liveCopySetupAbortSchema, requestLiveCopySetupAbortSchema } from '@trading-dashboard/shared/contracts';
const date = '2026-10-09T00:00:00.000Z';
const base = { id: '11111111-1111-4111-8111-111111111111', setupId: 'setup', kind: 'start', strategyId: 1,
  accountId: 'account', network: 'testnet', state: 'requested', issue: null, deposit: null, refund: null, stop: null, createdAt: date, updatedAt: date };
const transfer = { id: '22222222-2222-4222-8222-222222222222', accountId: 'account', strategyId: 1, network: 'testnet',
  address: `0x${'11'.repeat(20)}`, destination: `0x${'22'.repeat(20)}`, amount: '49', nonce: 1800000000000,
  status: 'accepted', canCancel: false, transactionHash: null, creditedAmount: null, fee: null, direction: 'to_account', createdAt: date, updatedAt: date };
describe('public setup abort authority and progress', () => {
  it('only requests the existing setup with an opaque idempotency key', () => {
    expect(requestLiveCopySetupAbortSchema.parse({ idempotencyKey: base.id })).toEqual({ idempotencyKey: base.id });
    for (const extra of [{ amount: '49' }, { destination: transfer.address }, { signature: 'private' }])
      expect(requestLiveCopySetupAbortSchema.safeParse({ idempotencyKey: base.id, ...extra }).success).toBe(false);
  });
  it('accepts saved progress while money is pending without presenting completion', () => {
    expect(liveCopySetupAbortSchema.parse({ ...base, state: 'reconciling', deposit: transfer }).state).toBe('reconciling');
    expect(liveCopySetupAbortSchema.safeParse({ ...base, state: 'completed', deposit: transfer }).success).toBe(false);
  });
  it('rejects funds belonging to another account, strategy, network or direction', () => {
    for (const change of [{ accountId: 'other' }, { strategyId: 2 }, { network: 'mainnet' }, { direction: 'to_main' }])
      expect(liveCopySetupAbortSchema.safeParse({ ...base, deposit: { ...transfer, ...change } }).success).toBe(false);
  });
  it('keeps a submitted refund pending until receipt confirmation', () => {
    const deposit = { ...transfer, status: 'credited', creditedAmount: '49' };
    const refund = { ...transfer, direction: 'to_main', address: transfer.destination, destination: transfer.address };
    expect(liveCopySetupAbortSchema.safeParse({ ...base, state: 'refunding', deposit, refund }).success).toBe(true);
    expect(liveCopySetupAbortSchema.safeParse({ ...base, state: 'completed', deposit, refund }).success).toBe(false);
    expect(liveCopySetupAbortSchema.safeParse({ ...base, state: 'completed', deposit, refund: { ...refund, status: 'credited', creditedAmount: '49' } }).success).toBe(true);
  });
  it('requires an original stop for delegation and a reason for a blocked operation', () => {
    expect(liveCopySetupAbortSchema.safeParse({ ...base, state: 'delegated' }).success).toBe(false);
    expect(liveCopySetupAbortSchema.safeParse({ ...base, state: 'blocked' }).success).toBe(false);
    expect(liveCopySetupAbortSchema.safeParse({ ...base, state: 'blocked', issue: 'setup_abort_binding_unknown' }).success).toBe(true);
  });
  it('rejects private authority internals and reversed progress times', () => {
    expect(liveCopySetupAbortSchema.safeParse({ ...base, consentDigest: 'a'.repeat(64) }).success).toBe(false);
    expect(liveCopySetupAbortSchema.safeParse({ ...base, updatedAt: '2026-10-08T00:00:00.000Z' }).success).toBe(false);
  });
});
