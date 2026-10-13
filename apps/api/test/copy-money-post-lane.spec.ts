import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import type { FundingRow } from '../src/copy/copy-funding.repository.js';
import { WithdrawalExchangeClient } from '../src/wallet/withdrawal-exchange.client.js';
import type { WithdrawalRow } from '../src/wallet/withdrawal.repository.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { liveDemandTicket, setupDemandTicket } from '../src/hyperliquid/hyperliquid-global-quota.js';
import { Meter } from './copy-setup-capacity-test-utils.js';

/**
 * Funding and withdrawal POSTs move real money and cost 1 unit each. They
 * carry a `live:` ticket: a full background lane, a waiting setup or another
 * live order's announced need never leaves them not dispatched, waiting for a
 * retry. Before, their charge was unlabelled: it had to leave what live
 * orders announced and granted setup claims still needed, and was refused
 * (funding_not_dispatched / withdrawal_not_dispatched) when those filled it.
 */
const signature = `0x${'11'.repeat(64)}1b`;
const funding = { id: 'f', network: 'testnet', address: `0x${'11'.repeat(20)}`, destination: `0x${'22'.repeat(20)}`, amount: '12.5', nonce: 1780000000000, attemptedAt: new Date(0) } as unknown as FundingRow;
const withdrawal = { id: 'w', network: 'testnet', destination: `0x${'22'.repeat(20)}`, amount: '12.5', nonce: 1780000000000 } as unknown as WithdrawalRow;
const budget = { acquire: vi.fn(async () => {}), liveCapacity: 1000, liveWaitMs: () => 0, refillMs: () => 0 } as unknown as RequestBudgeterService;
afterEach(() => { vi.unstubAllGlobals(); });

/** The window as a busy minute leaves it: background, a waiting setup, and another order's announced need. */
function busyMeter(): Meter {
  const meter = new Meter(), now = Date.now(), at = (units: number, id: string) => ({ id, kind: 'rest' as const, units, reservedAt: now, expiresAt: now + 65_000 });
  meter.state = { ...meter.state, updatedAt: now, events: [at(240, 'bg:loops'), at(1, setupDemandTicket(533, '0123456789abcdef')), at(1, liveDemandTicket(960, 'fedcba9876543210'))] };
  return meter;
}

describe('money-moving POSTs are the live lane on the shared meter', () => {
  it.each([
    ['usdSend (deposit, return, setup-abort refund, auto-return)', (global: HyperliquidGlobalTransport) => new CopyFundingExchangeClient(budget, global).send(funding, signature, () => undefined)],
    ['withdraw3', (global: HyperliquidGlobalTransport) => new WithdrawalExchangeClient(budget, global).send(withdrawal, signature, () => undefined)],
    ['an account action (builder fee approval)', (global: HyperliquidGlobalTransport) => new CopyFundingExchangeClient(budget, global).sendAction('testnet', { action: {} }, () => undefined)],
  ] as const)('%s is dispatched beside a full window of background, a waiting setup and another order\'s need', async (_name, send) => {
    const fetcher = vi.fn(async () => Response.json({ status: 'ok', response: { type: 'default' } })); vi.stubGlobal('fetch', fetcher);
    const meter = busyMeter(), global = new HyperliquidGlobalTransport(meter.quota(), { egressKey: 'gate:testnet', ownerId: 'api' });
    await send(global);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Its 1 unit is a live charge.
    expect(meter.state.events.filter(e => e.id.startsWith('live:')).map(e => e.units)).toEqual([1]);
    expect(meter.restHeld()).toBeLessThanOrEqual(1200);
  });
});
