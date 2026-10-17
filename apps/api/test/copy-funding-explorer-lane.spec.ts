import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import { CopyFundingService } from '../src/copy/copy-funding.service.js';
import type { FundingRow } from '../src/copy/copy-funding.repository.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { testConfig } from './config-test-utils.js';
import { offlineGlobalTransport } from './hyperliquid-quota-test-utils.js';

/**
 * The explorer's `txDetails` (40 units) is the shared meter's live lane only
 * while someone waits on it: a copy setup waiting for its deposit's credit,
 * or an owner's own lookup. The funding monitor's pass over other pending
 * transfers is background, so it never takes an order's room (H-R6,
 * 2026-10-17; before, every explorer read was live).
 */
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const source = `0x${'11'.repeat(20)}`, destination = `0x${'22'.repeat(20)}`;
afterEach(() => { vi.unstubAllGlobals(); });

describe('the explorer read\'s lane', () => {
  it('the client charges the live lane (owner `explorer`) for a read someone waits on, the background lane for the monitor\'s', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ type: 'txDetails', tx: {} }));
    const q = offlineGlobalTransport(fetcher);
    const budget = { acquire: vi.fn(async () => {}), liveCapacity: 1000, liveWaitMs: () => 0, refillMs: () => 0 };
    const client = new CopyFundingExchangeClient(budget as unknown as RequestBudgeterService, q.transport);
    await client.txDetails('testnet', hash(1));
    expect(q.acquire).toHaveBeenCalledExactlyOnceWith(40, expect.any(Number), undefined, { fallback: 'live', owner: 'explorer' });
    await client.txDetails('testnet', hash(2), 'background');
    expect(q.acquire).toHaveBeenLastCalledWith(40, expect.any(Number), 'background', { owner: 'explorer' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) expect(call[0]).toBe('https://rpc.hyperliquid-testnet.xyz/explorer');
  });

  it('the funding service: live for an owner\'s lookup and for a setup\'s deposit, background for the monitor\'s other transfers', async () => {
    const nonce = Date.now(), rows = new Map<string, FundingRow>();
    const row = (id: string, liveSetupId: string | null): FundingRow => ({ id, userId: 1, network: 'testnet', address: source, destination, amount: '10', nonce,
      status: 'accepted', attemptedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), scanRevision: 0, scanState: null, liveSetupId } as FundingRow);
    for (const r of [row('plain', null), row('setup', 'setup-1'), row('mine', null)]) rows.set(r.id, r);
    // The ledger shows the transfer; its details come from the explorer.
    const ledger = [{ hash: hash(1), time: nonce, delta: { type: 'internalTransfer', user: source, destination, usdc: '10', fee: '1' } }];
    const info = { userNonFundingLedgerUpdates: vi.fn(async () => structuredClone(ledger)) };
    const exchange = { send: vi.fn(), txDetails: vi.fn(async (_network: string, _hash: string, _priority?: string): Promise<unknown> => ({ type: 'txDetails', tx: { hash: hash(1), user: source, error: null,
      action: { type: 'usdSend', time: nonce, hyperliquidChain: 'Testnet', signatureChainId: '0x66eee', destination, amount: '10' } } })) };
    const repository = { find: vi.fn(async (_user: number, id: string) => structuredClone(rows.get(id)!)), claimPending: vi.fn(async () => ['plain', 'setup'].map(id => structuredClone(rows.get(id)!))),
      saveScan: vi.fn(async (expected: FundingRow, scanState: unknown) => { const next = { ...expected, scanState: structuredClone(scanState), scanRevision: expected.scanRevision + 1 } as FundingRow; rows.set(expected.id, next); return structuredClone(next); }),
      credit: vi.fn(async (_user: number, id: string) => { const next = { ...rows.get(id)!, status: 'credited' } as FundingRow; rows.set(id, next); return structuredClone(next); }), notExecuted: vi.fn(), saveBackoff: vi.fn() };
    const service = new CopyFundingService(testConfig(), repository as never, { overview: async () => ({}) } as never, exchange as never, info as never);
    // The monitor's pass: the plain transfer's read is background, the setup's deposit's live.
    await service.reconcilePending();
    expect(exchange.txDetails.mock.calls.map(call => [call[1], call[2]] as unknown[])).toEqual([[hash(1), 'background'], [hash(1), 'live']]);
    expect(['plain', 'setup'].map(id => rows.get(id)!.status)).toEqual(['credited', 'credited']);
    // An owner's own lookup of a transfer with no setup behind it: live (someone waits).
    exchange.txDetails.mockClear();
    await service.reconcile(1, 'mine');
    expect(exchange.txDetails.mock.calls.map(call => [call[1], call[2]] as unknown[])).toEqual([[hash(1), 'live']]);
  });
});
