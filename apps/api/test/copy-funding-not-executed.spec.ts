import { describe, expect, it, vi } from 'vitest';
import { CopyFundingService } from '../src/copy/copy-funding.service.js';
import { FUNDING_NONCE_EXPIRY_MS } from '../src/copy/copy-funding-scan.js';
import type { FundingRow } from '../src/copy/copy-funding.repository.js';
import { testConfig } from './config-test-utils.js';

// A transfer still unknown after its nonce window, with another (proven)
// transfer between the same two accounts inside that window: an earlier
// credited deposit must not keep it pending forever.
const main = `0x${'11'.repeat(20)}`, account = `0x${'22'.repeat(20)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const nonce = Date.now() - FUNDING_NONCE_EXPIRY_MS - 60_000, earlier = nonce - 3_600_000;
type Details = (network: string, h: string) => Promise<unknown>;
function setup(direction: 'to_account' | 'to_main', details: Details, transfers = 1) {
  const [address, destination] = direction === 'to_account' ? [main, account] : [account, main];
  let row = { id: 'd2', userId: 1, network: 'testnet', address, destination, amount: '10', nonce, direction,
    status: 'unknown', attemptedAt: new Date(nonce), claimedAt: new Date(nonce), createdAt: new Date(nonce), updatedAt: new Date(nonce),
    scanRevision: 0, scanState: null } as unknown as FundingRow;
  // D1: the earlier transfer between the same two accounts, inside D2's window.
  const ledger = Array.from({ length: transfers }, (_, i) => ({ hash: hash(i + 1), time: earlier + 50 + i, delta: { type: 'internalTransfer', user: address, destination, usdc: '10', fee: '1' } }));
  const info = { userNonFundingLedgerUpdates: vi.fn(async () => structuredClone(ledger)) };
  const exchange = { send: vi.fn(), txDetails: vi.fn(details) };
  const repository = { find: vi.fn(async () => structuredClone(row)),
    saveScan: vi.fn(async (expected: FundingRow, scanState: unknown) => {
      if (expected.scanRevision !== row.scanRevision) return null;
      row = { ...row, scanState: structuredClone(scanState), scanRevision: row.scanRevision + 1 } as FundingRow;
      return structuredClone(row);
    }),
    credit: vi.fn(), notExecuted: vi.fn(async (expected: FundingRow) => {
      if (expected.scanRevision !== row.scanRevision || row.status !== 'unknown') return null;
      row = { ...row, status: 'rejected' } as FundingRow;
      return structuredClone(row);
    }),
  };
  const service = new CopyFundingService(testConfig(), repository as never, { overview: async () => ({}) } as never, exchange as never, info as never);
  const tx = (h: string, action: Record<string, unknown>, user = address) => ({ type: 'txDetails', tx: { hash: h, user, error: null, time: earlier + 50,
    action: { type: 'usdSend', hyperliquidChain: 'Testnet', signatureChainId: '0x66eee', destination, amount: '10', time: earlier, ...action } } });
  // Each turn is a fresh process (past the lookup cache), as the monitor's are.
  const settle = async () => {
    let status = 'unknown';
    for (let i = 0; i < 4 && status === 'unknown'; i++) status = (await new CopyFundingService(testConfig(), repository as never, { overview: async () => ({}) } as never, exchange as never, info as never).reconcile(1, 'd2')).status;
    return status;
  };
  return { service, exchange, repository, tx, settle, current: () => row, address, destination };
}

describe.each(['to_account', 'to_main'] as const)('an unknown %s transfer after its nonce window', (direction) => {
  it('is rejected as not executed when the only matching transfer is proven to be another operation (earlier nonce)', async () => {
    const s = setup(direction, async (_n, h) => s.tx(h, {}));
    expect((await s.service.reconcile(1, 'd2')).status).toBe('rejected');
    expect(s.repository.notExecuted).toHaveBeenCalledTimes(1);
    expect(s.repository.credit).not.toHaveBeenCalled();
    expect(s.exchange.send).not.toHaveBeenCalled();
  });
  it('is rejected after more earlier transfers than one details batch (counted once each)', async () => {
    const s = setup(direction, async (_n, h) => s.tx(h, { time: earlier - Number(BigInt(h)) }), 7);
    expect(await s.settle()).toBe('rejected');
    expect(s.exchange.txDetails).toHaveBeenCalledTimes(7);
  });
  it('stays pending when one of more than a details batch cannot be proven another operation', async () => {
    const s = setup(direction, async (_n, h) => h === hash(7) ? null : s.tx(h, {}), 7);
    expect(await s.settle()).toBe('unknown');
    expect(s.exchange.txDetails.mock.calls.map(call => call[1])).toContain(hash(7));
    expect(s.repository.notExecuted).not.toHaveBeenCalled();
  });
  it.each([
    ['unreadable details', null],
    ['details for another hash', 'other-hash'],
    ['the same nonce (unprovable match)', { time: nonce, amount: '11' }],
    ['a missing nonce', { time: undefined }],
    ['another signer', 'other-user'],
    ['another destination', { destination: `0x${'33'.repeat(20)}` }],
    ['another action type', { type: 'spotSend' }],
    ['another chain', { hyperliquidChain: 'Mainnet' }],
  ] as const)('stays pending when the matching transfer has %s', async (_label, variant) => {
    const s = setup(direction, async (_n, h) => variant === null ? null : variant === 'other-hash' ? s.tx(hash(9), {})
      : variant === 'other-user' ? s.tx(h, {}, `0x${'44'.repeat(20)}`) : s.tx(h, variant));
    expect((await s.service.reconcile(1, 'd2')).status).toBe('unknown');
    expect(s.repository.notExecuted).not.toHaveBeenCalled();
    expect(s.repository.credit).not.toHaveBeenCalled();
  });
  it('stays pending while the details cannot be read, then is rejected once they prove another operation', async () => {
    const s = setup(direction, async () => { throw new Error('quota'); });
    await expect(s.service.reconcile(1, 'd2')).rejects.toThrow('Funding confirmation unavailable');
    expect(s.current()).toMatchObject({ status: 'unknown', scanState: { seen: 1, pendingDetails: [{ hash: hash(1) }] } });
    expect(s.repository.notExecuted).not.toHaveBeenCalled();
    s.exchange.txDetails.mockImplementation(async (_n, h) => s.tx(h, {}));
    const restarted = new CopyFundingService(testConfig(), s.repository as never, { overview: async () => ({}) } as never, s.exchange as never,
      { userNonFundingLedgerUpdates: vi.fn(async () => []) } as never);
    expect((await restarted.reconcile(1, 'd2')).status).toBe('rejected');
  });
});
