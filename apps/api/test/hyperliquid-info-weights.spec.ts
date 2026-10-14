import { describe, expect, it, vi } from 'vitest';
import { infoListSurcharge, infoPrepaidWeight, infoWeight } from '../src/hyperliquid/info-weights.js';
import { TRANSPORT_INFO_TYPES } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { liveInfoWeight } from '../src/copy/live/live-shared-reads.js';
import { HyperliquidAgentApprovalVerifier } from '../src/copy/live/hyperliquid-agent-approval.js';
import type { WalletAuthorization } from '../src/copy/live/wallet-authorization.js';
import { offlineGlobalTransport } from './hyperliquid-quota-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { LIVE_ORDER_BOUNDARY_WEIGHT } from '../src/config/constants/weights.js';

const info = 'https://api.hyperliquid-testnet.xyz/info', user = `0x${'12'.repeat(20)}`;
const metered = async (type: string) => {
  const q = offlineGlobalTransport(vi.fn<typeof fetch>(async () => Response.json([])));
  await q.transport.fetchInfo(info, { method: 'POST', body: JSON.stringify({ type }), headers: { 'Content-Type': 'application/json' } });
  return (q.acquire.mock.calls[0] as unknown as [number])[0];
};

describe('one Hyperliquid info weight table', () => {
  it('has the documented weights', () => {
    for (const type of ['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']) expect(infoWeight({ type })).toBe(2);
    expect(infoWeight({ type: 'userRole' })).toBe(60);
    for (const type of ['meta', 'extraAgents', 'userAbstraction', 'userFills', 'candleSnapshot', 'somethingNew']) expect(infoWeight({ type })).toBe(20);
    expect([infoListSurcharge('userFills', 0), infoListSurcharge('userFills', 21), infoListSurcharge('userFills', 5000), infoListSurcharge('candleSnapshot', 61), infoListSurcharge('meta', 100)]).toEqual([0, 2, 100, 2, 0]);
    expect([infoPrepaidWeight({ type: 'userFills' }), infoPrepaidWeight({ type: 'candleSnapshot' }), infoPrepaidWeight({ type: 'meta' })]).toEqual([120, 104, 20]);
  });
  // The shared meter, live evidence and the info client used to keep three
  // tables (l2Book 2 vs 20, a list 120 vs 20, an unknown type refused vs 20).
  it.each(TRANSPORT_INFO_TYPES.map(type => [type]))('the meter and live evidence charge %s alike', async type => {
    expect(await metered(type)).toBe(infoPrepaidWeight({ type }));
    expect(liveInfoWeight({ type })).toBe(infoPrepaidWeight({ type }));
  });
  it('the info client takes the table\'s weight locally and the meter\'s globally', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(null)), q = offlineGlobalTransport(fetcher);
    const local = { acquire: vi.fn(async () => {}), adjust: vi.fn(), onSuccess: vi.fn(), onRateLimited: vi.fn() };
    const client = new HyperliquidInfoClient(testConfig(), local as unknown as RequestBudgeterService, undefined, q.transport);
    const calls: [string, () => Promise<unknown>][] = [['perpDexs', () => client.perpDexs()], ['meta', () => client.meta()], ['allPerpMetas', () => client.allPerpMetas()],
      ['metaAndAssetCtxs', () => client.metaAndAssetCtxs()], ['allMids', () => client.allMids()], ['spotMetaAndAssetCtxs', () => client.spotMetaAndAssetCtxs()],
      ['userAbstraction', () => client.userAbstraction(user)], ['delegatorSummary', () => client.delegatorSummary(user)], ['portfolio', () => client.portfolio(user)],
      ['referral', () => client.referral(user)], ['userFills', () => client.userFills(user)], ['userFunding', () => client.userFunding(user, 0)]];
    for (const [type, call] of calls) {
      local.acquire.mockClear(); q.acquire.mockClear();
      await call().catch(() => undefined);
      const [weight, , , options] = local.acquire.mock.calls[0] as unknown as [number, unknown, unknown, { known?: number }];
      expect(options?.known ?? weight, type).toBe(infoWeight({ type }));
      expect((q.acquire.mock.calls[0] as unknown as [number])[0], type).toBe(infoPrepaidWeight({ type }));
    }
  });
  it('an order\'s boundary weight is its agent\'s approval read and the POST', async () => {
    const account = `0x${'22'.repeat(20)}` as const, weights: number[] = [];
    const grant = { id: 'grant', version: 1, userId: 1, strategyId: 2, walletId: 'wallet', privyOwnerId: 'quorum', signerAddress: `0x${'33'.repeat(20)}`, accountAddress: account,
      network: 'testnet', scopes: ['copy:trade'], validFrom: 0, expiresAt: Date.now() + 100_000, revokedAt: null, exchangeApprovedAt: 0 } as unknown as WalletAuthorization;
    const verifier = new HyperliquidAgentApprovalVerifier('testnet', async weight => { weights.push(weight); }, vi.fn<typeof fetch>(async () => Response.json({ role: 'user' })));
    await verifier.verify(grant).catch(() => undefined);
    // A self-signing account (never an order's grant) reads userRole instead.
    await verifier.verify({ ...grant, signerAddress: account });
    expect(weights).toEqual([20, 60]);
    expect(LIVE_ORDER_BOUNDARY_WEIGHT).toBe(weights[0]! + 1);
  });
});
