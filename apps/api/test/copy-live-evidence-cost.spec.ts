import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProviderReadEpoch } from '../src/copy/live/live-provider-read-epoch.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { liveInfoWeight } from '../src/copy/live/live-shared-reads.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { getTestDb, closeTestDb, type TestDb } from './db-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';

// One order's evidence epoch with the concrete observer, resolver and risk
// provider; only the testnet info endpoint and the account socket are fakes.
let db: TestDb, pool: Pool, clock: number, scope: PostgresLiveRiskScope, seed: Awaited<ReturnType<typeof preparationFixture>>;
const COINS = ['BTC', 'ETH', 'SOL', 'HYPE'], options = { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 };
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }); });
beforeEach(async () => { seed = await preparationFixture(db); clock = now; scope = new PostgresLiveRiskScope(pool, () => clock); });
afterAll(async () => { await pool.end(); await closeTestDb(); });
const identity = () => ({ userId: 1, network: 'testnet' as const, accountAddress: seed.f.identity.accountAddress, source: { network: 'testnet' as const, leaderAddress: seed.consent.leaderAddress } });

function venue(open: string[]) {
  const meta = { collateralToken: 7, universe: COINS.map(name => ({ name, szDecimals: 2, maxLeverage: 20 })) };
  const sent: Record<string, unknown>[] = [], waves: string[][] = [];
  const answer = (body: Record<string, unknown>): unknown => ({
    userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false, spotClearinghouseState: { portfolioMarginEnabled: false, balances: [] },
    perpDexs: [null], spotMeta: { tokens: [{ index: 7, name: 'USDC', isCanonical: true }] }, meta, allPerpMetas: [meta],
    metaAndAssetCtxs: [meta, COINS.map(() => ({ midPx: '100', markPx: '100' }))],
    activeAssetData: { user: body.user, coin: body.coin, leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['1', '1'], availableToTrade: ['100', '100'], markPx: '100' },
    userFees: { userAddRate: '0.0001', userCrossRate: '0.00035', activeReferralDiscount: '0', trial: null },
  } as Record<string, unknown>)[String(body.type)];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); sent.push(body); return Response.json(answer(body)); });
  const batch = vi.fn(async (bodies: readonly Readonly<Record<string, unknown>>[], onDispatch: () => void) => {
    onDispatch(); waves.push(bodies.map(b => String(b.type))); sent.push(...bodies.map(b => ({ ...b })));
    return bodies.map(body => Response.json(answer(body as Record<string, unknown>)));
  });
  const value = String(5 * open.length), margin = String(0.5 * open.length);
  const sums = { accountValue: '100', totalNtlPos: value, totalRawUsd: '100', totalMarginUsed: margin };
  const state = { marginSummary: sums, crossMarginSummary: sums, crossMaintenanceMarginUsed: open.length ? '0.1' : '0', withdrawable: String(100 - 0.5 * open.length), time: clock,
    assetPositions: open.map(coin => ({ type: 'oneWay', position: { coin, szi: '0.05', entryPx: '100', positionValue: '5', unrealizedPnl: '0', marginUsed: '0.5', maxLeverage: 20,
      leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } })) };
  const sockets = { read: async (user: string) => ({ network: 'testnet' as const, accountAddress: user, observedAt: clock, data: { user, clearinghouseStates: [['', state]] } }),
    readOrders: async (user: string, dexes: readonly string[]) => ({ network: 'testnet' as const, accountAddress: user, observedAt: clock, completedAt: clock, requestedDexes: [...dexes],
      venues: dexes.map(dex => ({ dex, user, observedAt: clock, receivedAt: clock, orders: [] })) }) };
  const acquire = vi.fn(async (_weight: number) => {});
  const observer = new HyperliquidLiveAccountObserver('testnet', acquire, fetcher, () => clock, 5000, sockets);
  const resolver = new HyperliquidLiveMarketResolver('testnet', acquire, fetcher, () => clock);
  const provider = new HyperliquidLiveRiskProvider('testnet', acquire, fetcher, () => clock);
  return { observer, resolver, provider, acquire, fetcher, batch, sent, waves };
}
const weight = (bodies: Record<string, unknown>[]) => bodies.reduce((sum, body) => sum + liveInfoWeight(body), 0);
const acquired = (acquire: ReturnType<typeof vi.fn>) => acquire.mock.calls.reduce((sum, [w]) => sum + (w as number), 0);

describe('one order\'s evidence reads (shared epoch)', () => {
  it('pays exactly what it reads, at most 450 with three other coins open, the other coins read in parallel in one wave', async () => {
    const v = venue(['ETH', 'SOL', 'HYPE']);
    const epoch = new LiveProviderReadEpoch(v.observer, v.resolver, v.provider, options, () => clock, { acquire: v.acquire, fetcher: v.fetcher, batch: v.batch });
    const frames = await scope.run(identity(), async (_s, session) => epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: 'cost', coin: 'BTC' }));
    expect(frames.others.map(p => p.coin).sort()).toEqual(['ETH', 'HYPE', 'SOL']);
    expect(acquired(v.acquire)).toBe(weight(v.sent)); expect(acquired(v.acquire)).toBe(424);
    // Waves: everything known up front; the other coins' leverage; the final check.
    expect(v.waves).toEqual([
      ['userRole', 'userAbstraction', 'userDexAbstraction', 'spotClearinghouseState', 'perpDexs', 'spotMeta', 'allPerpMetas', 'meta', 'metaAndAssetCtxs', 'activeAssetData', 'userFees'],
      ['activeAssetData', 'activeAssetData', 'activeAssetData'],
      ['userRole', 'userAbstraction', 'userDexAbstraction', 'spotClearinghouseState', 'perpDexs']]);
    expect(v.fetcher).not.toHaveBeenCalled();
  });

  it('without sharing, the same order read 1,580 (each reader alone, coin after coin)', async () => {
    const v = venue(['ETH', 'SOL', 'HYPE']);
    const epoch = new LiveProviderReadEpoch(v.observer, v.resolver, v.provider, options, () => clock);
    await scope.run(identity(), async (_s, session) => epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: 'cost', coin: 'BTC' }));
    expect(weight(v.sent)).toBe(1580); expect(acquired(v.acquire)).toBe(1580);
  });

  it('refuses when the account mode changes while it is observed', async () => {
    const v = venue([]);
    let reads = 0;
    v.batch.mockImplementation(async (bodies, onDispatch) => {
      onDispatch(); v.sent.push(...bodies.map(b => ({ ...b })));
      return bodies.map(body => Response.json(body.type === 'userAbstraction' && reads++ > 0 ? 'unifiedAccount' : (({
        userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false, spotClearinghouseState: { portfolioMarginEnabled: false, balances: [] }, perpDexs: [null],
        spotMeta: { tokens: [{ index: 7, name: 'USDC', isCanonical: true }] },
        meta: { collateralToken: 7, universe: COINS.map(name => ({ name, szDecimals: 2, maxLeverage: 20 })) },
        allPerpMetas: [{ collateralToken: 7, universe: COINS.map(name => ({ name, szDecimals: 2, maxLeverage: 20 })) }],
        metaAndAssetCtxs: [{ collateralToken: 7, universe: COINS.map(name => ({ name, szDecimals: 2, maxLeverage: 20 })) }, COINS.map(() => ({ midPx: '100', markPx: '100' }))],
        activeAssetData: { user: body.user, coin: body.coin, leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['1', '1'], availableToTrade: ['100', '100'], markPx: '100' },
        userFees: { userAddRate: '0.0001', userCrossRate: '0.00035', activeReferralDiscount: '0', trial: null },
      } as Record<string, unknown>)[String(body.type)])));
    });
    const epoch = new LiveProviderReadEpoch(v.observer, v.resolver, v.provider, options, () => clock, { acquire: v.acquire, fetcher: v.fetcher, batch: v.batch });
    await expect(scope.run(identity(), async (_s, session) => epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: 'cost', coin: 'BTC' })))
      .rejects.toThrow('live_account_observation_changed');
  });
});
