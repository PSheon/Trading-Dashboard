import { expect, it, vi } from 'vitest';
import { CopyFundingService } from '../src/copy/copy-funding.service.js';
import type { FundingRow } from '../src/copy/copy-funding.repository.js';
import { testConfig } from './config-test-utils.js';

const source = `0x${'11'.repeat(20)}`, destination = `0x${'22'.repeat(20)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
function setup(count = 1) {
  let row = { id: 'original', userId: 1, network: 'testnet', address: source, destination, amount: '10', nonce: Date.now(),
    status: 'accepted', attemptedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), scanRevision: 0, scanState: null } as FundingRow;
  const ledger = Array.from({ length: count }, (_, i) => ({ hash: hash(i + 1), time: row.nonce, delta: { type: 'internalTransfer', user: source, destination, usdc: '10', fee: '1' } }));
  const info = { userNonFundingLedgerUpdates: vi.fn(async () => structuredClone(ledger)) };
  const exchange = { send: vi.fn(), txDetails: vi.fn(async (_network: string, h: string): Promise<unknown> => ({ type: 'txDetails', tx: {
    hash: h, user: source, error: null, action: { type: 'usdSend', time: h === hash(1) ? row.nonce : row.nonce + 1,
      hyperliquidChain: 'Testnet', signatureChainId: '0x66eee', destination, amount: '10' },
  } })) };
  const repository = { find: vi.fn(async () => structuredClone(row)),
    saveScan: vi.fn(async (expected: FundingRow, scanState: unknown) => {
      if (expected.scanRevision !== row.scanRevision) return null;
      row = { ...row, scanState: structuredClone(scanState), scanRevision: row.scanRevision + 1 };
      return structuredClone(row);
    }),
    credit: vi.fn(async (_user: number, _id: string, receipt: { creditedAmount: string }, _digest: string, revision: number) => {
      expect(revision).toBe(row.scanRevision);
      row = { ...row, status: 'credited', creditedAmount: receipt.creditedAmount };
      return structuredClone(row);
    }), notExecuted: vi.fn(),
  };
  const restart = () => new CopyFundingService(testConfig(), repository as never, { overview: async () => ({}) } as never, exchange as never, info as never);
  return { restart, info, exchange, repository, ledger, current: () => row };
}
it('resumes explorer confirmation after quota failure and process restart without reading the ledger again or resending', async () => {
  const s = setup(); s.exchange.txDetails.mockRejectedValueOnce(new Error('live_budget_wait'));
  await expect(s.restart().reconcile(1, 'original')).rejects.toThrow('Funding confirmation unavailable');
  expect(s.current().scanState).toMatchObject({ pendingDetails: [{ hash: hash(1) }] });
  expect((await s.restart().reconcile(1, 'original')).status).toBe('credited');
  expect(s.info.userNonFundingLedgerUpdates).toHaveBeenCalledTimes(1);
  expect(s.repository.credit).toHaveBeenCalledTimes(1);
  expect(s.exchange.send).not.toHaveBeenCalled();
});
it('retains each completed detail and retries only the interrupted hash', async () => {
  const s = setup(2), original = s.exchange.txDetails.getMockImplementation()!;
  s.exchange.txDetails.mockImplementationOnce(original).mockRejectedValueOnce(new Error('quota'));
  await expect(s.restart().reconcile(1, 'original')).rejects.toThrow();
  expect(s.current().scanState).toMatchObject({ receipts: [{ transactionHash: hash(1) }], pendingDetails: [{ hash: hash(2) }] });
  expect((await s.restart().reconcile(1, 'original')).status).toBe('credited');
  expect(s.exchange.txDetails.mock.calls.map(call => call[1])).toEqual([hash(1), hash(2), hash(2)]);
  expect(s.info.userNonFundingLedgerUpdates).toHaveBeenCalledTimes(1);
});
it('keeps duplicate ledger rows ambiguous across a checkpoint and restart', async () => {
  const s = setup(); s.ledger.push(structuredClone(s.ledger[0]!));
  s.exchange.txDetails.mockRejectedValueOnce(new Error('quota'));
  await expect(s.restart().reconcile(1, 'original')).rejects.toThrow();
  expect((await s.restart().reconcile(1, 'original')).status).toBe('accepted');
  expect(s.repository.credit).not.toHaveBeenCalled();
  expect(s.repository.notExecuted).not.toHaveBeenCalled();
});
it('stops at a lost checkpoint revision instead of processing or crediting from stale evidence', async () => {
  const s = setup(); s.repository.saveScan.mockResolvedValueOnce(null);
  expect((await s.restart().reconcile(1, 'original')).status).toBe('accepted');
  expect(s.exchange.txDetails).not.toHaveBeenCalled();
  expect(s.repository.credit).not.toHaveBeenCalled();
});
