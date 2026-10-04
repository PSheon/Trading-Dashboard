import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { TypedDataDefinition } from 'viem';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { TestnetLiveExecutionRuntime } from '../src/copy/live/testnet-live-execution-runtime.js';
import { CopyFollowerLedger } from '../src/copy/live/copy-follower-ledger.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { CopyLiveEngine } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveSettler } from '../src/copy/live-worker/copy-live-settler.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Only native network endpoints are doubles (Privy, Hyperliquid REST/WS).
// The engine, runtime, risk, journal, reservation, receipt ledger and
// settlement are the production classes on a real database.
const shared = vi.hoisted(() => ({ clock: 0, position: '0' }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; static CLOSED = 3; readyState = 1;
    constructor(readonly url: string, readonly options: unknown) { super(); }
    send(value: string) {
      const request = JSON.parse(value), subscription = request.subscription;
      queueMicrotask(() => {
        this.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
        if (request.method !== 'subscribe') return;
        const size = shared.position, notional = String(Math.abs(Number(size)) * 100), margin = String(Math.abs(Number(size)) * 10);
        const sums = { accountValue: '100', totalNtlPos: notional, totalRawUsd: String(100 - Number(notional)), totalMarginUsed: margin };
        const assetPositions = size === '0' ? [] : [{ type: 'oneWay', position: { coin: 'BTC', szi: size, entryPx: '100', positionValue: notional, unrealizedPnl: '0',
          marginUsed: margin, maxLeverage: 20, leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }];
        const state = { marginSummary: sums, crossMarginSummary: sums, crossMaintenanceMarginUsed: '0', withdrawable: '80', time: Date.now(), assetPositions };
        this.emit('message', Buffer.from(JSON.stringify(subscription.type === 'allDexsClearinghouseState'
          ? { channel: subscription.type, data: { user: subscription.user, clearinghouseStates: [['', state]] } }
          : { channel: 'openOrders', data: { user: subscription.user, dex: subscription.dex, orders: [] } })));
      });
    }
    close(code: number) { this.readyState = 3; this.emit('close', code, Buffer.alloc(0)); }
    terminate() { this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)); }
  } };
});

const authorizationKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const agent = privateKeyToAccount(`0x${'11'.repeat(32)}`), leader = `0x${'44'.repeat(20)}`;
let db: TestDb, pool: Pool, seed: Awaited<ReturnType<typeof preparationFixture>>, budget: RequestBudgeterService, config: AppConfig, global: HyperliquidGlobalTransport;
let logs: string[] = [], weights: number[] = [];
let raw: ReturnType<typeof vi.fn<typeof fetch>>, exchangeBodies: unknown[], placedOid: number | null, placedSize: string, placedAt = 0;
// The actual clock throughout: the shared egress quota checks deadlines against it.
const clock = () => Date.now();

beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); });
afterEach(() => { budget.onModuleDestroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await pool.end(); await closeTestDb(); });

beforeEach(async () => {
  seed = await preparationFixture(db); await db.delete(schema.hyperliquidWsLeases); await db.delete(schema.hyperliquidEgressQuota);
  config = new AppConfig(validateEnvironment({ DATABASE_URL: process.env.TEST_DATABASE_URL, HYPERLIQUID_EGRESS_KEY: 'e2e-shared-egress', HYPERLIQUID_NETWORK: 'testnet',
    PRIVY_APP_ID: 'offline-app', PRIVY_APP_SECRET: 'offline-secret', PRIVY_AGENT_AUTHORIZATION_KEY: authorizationKey, PRIVY_AGENT_WORKER_QUORUM_ID: 'worker',
    COPY_TRADING_MODE: 'testnet', HYPERLIQUID_STARTUP_PACE_SECONDS: '0', HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: '200', HYPERLIQUID_WEIGHT_BURST: '1000' }));
  budget = new RequestBudgeterService(config);
  const original = budget.acquire.bind(budget); weights = [];
  vi.spyOn(budget, 'acquire').mockImplementation((weight, ...rest) => { weights.push(weight); return original(weight, ...rest); });
  // The actual clock, so every bound identity and consent is current.
  shared.clock = Date.now(); shared.position = '0'; logs = []; exchangeBodies = []; placedOid = null; placedSize = '0';
  const t = shared.clock, delta = t - now, date = (value: number) => new Date(value + delta);
  const [version] = await db.select().from(schema.copyStrategyVersions);
  const settings = { ...version!.settings, perTradeUsd: 20 };
  await db.update(schema.copyStrategyVersions).set({ settings });
  const consent = { ...seed.consent, sourceNetwork: 'mainnet' as const, settingsDigest: liveCopySettingsDigest(settings), agentAddress: agent.address.toLowerCase(),
    nonce: seed.consent.nonce + delta, consentExpiresAt: seed.consent.consentExpiresAt + delta, expiresAt: seed.consent.expiresAt + delta };
  await db.update(schema.copyWalletAuthorizations).set({ validFrom: date(now - 1), expiresAt: date(now + 60000), exchangeApprovedAt: date(now - 1) });
  await db.update(schema.copyExecutionWallets).set({ signerAddress: consent.agentAddress });
  await db.update(schema.copyAgentSetups).set({ agentAddress: consent.agentAddress, expiresAt: date(now + 60000), createdAt: date(now - 4000), updatedAt: date(now - 1) });
  await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'mainnet' });
  await db.update(schema.copyLiveMandates).set({ sourceNetwork: 'mainnet', settingsDigest: consent.settingsDigest, agentAddress: consent.agentAddress, nonce: consent.nonce,
    intent: consent, intentDigest: mandateDigest(consent), consentExpiresAt: new Date(consent.consentExpiresAt), expiresAt: new Date(consent.expiresAt),
    activationCursor: date(now - 2000), createdAt: date(now - 3000), updatedAt: date(now - 2000) });
  await db.delete(schema.copyLiveSourceFills); await db.delete(schema.copyLiveSourceStreams);
  await db.update(schema.copyStrategies).set({ status: 'paused', pauseNewRisk: true });
  await db.insert(schema.copyFundingOperations).values({ id: 'fund', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'fund-key-0000000001', network: 'testnet',
    address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '100', nonce: 1, status: 'credited', claimedAt: date(now - 9000), attemptedAt: date(now - 9000),
    evidenceHash: 'a'.repeat(64), transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '100', fee: '0' });
  await db.insert(schema.fillCoverage).values({ address: leader, verifiedFrom: date(now - 10_000), verifiedThrough: date(now + 60_000), backfillFloor: date(now - 10_000) });
  raw = vi.fn<typeof fetch>(async (url, init) => providers(String(url), init?.body ? JSON.parse(String(init.body)) : undefined));
  global = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: 'e2e-shared-egress', ownerId: 'e2e' }, raw);
  vi.stubGlobal('fetch', raw);
});

const meta = { collateralToken: 7, universe: [{ name: 'BTC', szDecimals: 2, maxLeverage: 20 }] };
async function providers(endpoint: string, body: Record<string, unknown> | undefined): Promise<Response> {
  if (endpoint === 'https://api.privy.io/v1/wallets/agent') return Response.json({ id: 'agent', chain_type: 'ethereum', address: agent.address, owner_id: 'owner', archived_at: null });
  if (endpoint === 'https://api.privy.io/v1/wallets/agent/rpc') {
    const typed = (body as { params: { typed_data: Record<string, unknown> & { primary_type: string } } }).params.typed_data;
    return Response.json({ method: 'eth_signTypedData_v4', data: { encoding: 'hex', signature: await agent.signTypedData({ ...typed, primaryType: typed.primary_type } as unknown as TypedDataDefinition) } });
  }
  if (endpoint === 'https://api.hyperliquid-testnet.xyz/exchange') {
    exchangeBodies.push(body); const order = (body as { action: { orders: { s: string }[] } }).action.orders[0]!;
    placedOid = 77; placedSize = order.s; placedAt = Date.now(); shared.position = order.s;
    return Response.json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 77, totalSz: order.s, avgPx: '100' } }] } } });
  }
  expect(endpoint).toBe('https://api.hyperliquid-testnet.xyz/info');
  const placed = (exchangeBodies[0] as { action: { orders: { c: string; p: string; s: string }[] } } | undefined)?.action.orders[0];
  const user = body!.user;
  const values: Record<string, unknown> = { userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false,
    spotClearinghouseState: { portfolioMarginEnabled: false, balances: [] }, perpDexs: [null], spotMeta: { tokens: [{ index: 7, name: 'USDC', isCanonical: true }] },
    meta, allPerpMetas: [meta], metaAndAssetCtxs: [meta, [{ midPx: '100', markPx: '100' }]],
    activeAssetData: { user, coin: 'BTC', leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['1', '1'], availableToTrade: ['100', '100'], markPx: '100' },
    userFees: { userAddRate: '-0.0001', userCrossRate: '0.0005', activeReferralDiscount: '0', trial: null },
    extraAgents: [{ address: agent.address, name: 'dedicated', validUntil: Date.now() + 60000 }],
    orderStatus: placedOid && placed ? { status: 'order', order: { status: 'filled', statusTimestamp: placedAt + 2, order: { coin: 'BTC', oid: placedOid, cloid: placed.c, side: 'B', reduceOnly: false,
      tif: 'Ioc', origSz: placed.s, sz: '0', limitPx: placed.p, timestamp: placedAt, isTrigger: false, isPositionTpsl: false, children: [] } } } : { status: 'unknownOid' },
    userFillsByTime: placedOid ? [{ coin: 'BTC', px: '100', sz: placedSize, side: 'B', time: placedAt + 1, startPosition: '0', dir: 'Open Long', closedPnl: '0',
      hash: `0x${'34'.repeat(32)}`, oid: placedOid, crossed: true, fee: '0.01', tid: 501, feeToken: 'USDC' }] : [], userFunding: [] };
  if (!(String(body!.type) in values)) throw Error(`Unsupported offline INFO ${String(body!.type)}`);
  return Response.json(values[String(body!.type)]);
}
function engine(midPrice = '100') {
  const reference = { read: vi.fn(async () => ({ midPrice, midObservedAt: Date.now(), leaderEquity: null, leaderEquityObservedAt: null })) };
  const options = { slippageBps: '30', extraRiskBufferBps: '5', restingOrderBuilderFeeCapTenthsBps: 100, maxSourceDeviationBps: '500' };
  return new CopyLiveEngine({
    repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db)), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db, clock), testnetSource: { read: vi.fn() } as never,
    runtime: hooks => new TestnetLiveExecutionRuntime(pool, config, global, budget, options, clock, { ...hooks, reference }),
    // Settlement right after the order: its own bucket, as the next pass would find refilled.
    settler: new CopyLiveSettler(pool, global, new RequestBudgeterService(config), new CopyFollowerLedger(db, new UnitOfWork(db)), clock), log: message => logs.push(message),
  }, { testnetSourceIntervalMs: 60_000, sourceLagMs: 0, passBudgetMs: 60_000 }, clock);
}
async function leaderOpens() {
  await new Promise(resolve => setTimeout(resolve, 5));
  const time = Date.now() - 2, rawFill = { coin: 'BTC', px: '100', sz: '1', side: 'B', time, startPosition: '0', dir: 'Open Long', closedPnl: '0',
    hash: `0x${'12'.repeat(32)}`, oid: 2001, crossed: true, fee: '0.01', tid: 1001, feeToken: 'USDC' };
  await db.insert(schema.fills).values({ address: leader, tid: 1001n, coin: 'BTC', side: 'B', dir: 'Open Long', px: '100', sz: '1', fee: '0.01', hash: rawFill.hash, ts: new Date(time), raw: rawFill });
}

describe('testnet copy of a mainnet leader, end to end against provider doubles', { timeout: 30_000 }, () => {
  it('a funded copy mirrors the leader open with one signed IOC on testnet, books the actual fill and settles the leg', async () => {
    const e = engine();
    await e.tick(); // activation and the first (empty) coverage window
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'active' });
    await leaderOpens(); const before = weights.length; await e.tick();
    expect(weights.slice(before).reduce((a, b) => a + b, 0)).toBeLessThan(900); // fits the default testnet burst
    expect(logs).toEqual([]); expect(exchangeBodies).toHaveLength(1);
    expect(exchangeBodies[0]).toMatchObject({ action: { type: 'order', orders: [{ a: 0, b: true, p: '100.3', s: '0.19', r: false, t: { limit: { tif: 'Ioc' } } }] } });
    let [row] = await db.select().from(schema.copyLiveDispatches);
    expect(row).toMatchObject({ leg: 'open', state: 'submitted', attempts: 1 }); expect(row!.sentAt).not.toBeNull(); expect(row!.ackedAt).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    [row] = await db.select().from(schema.copyLiveDispatches);
    expect(row).toMatchObject({ state: 'settled', reason: null });
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]).toMatchObject({ state: 'released', releaseReason: 'verified_settlement' });
    expect((await db.select().from(schema.copyLiveSignalLegs))[0]).toMatchObject({ leg: 'open', state: 'settled' });
    expect(await db.select().from(schema.copyFollowerReceipts)).toHaveLength(1);
    // Later passes neither sign nor send again.
    await e.tick(); expect(exchangeBodies).toHaveLength(1);
  });
  it('refuses the open when the testnet mid strays from mainnet beyond the threshold; nothing is signed or sent', async () => {
    const e = engine('120'); await e.tick(); await leaderOpens(); await e.tick();
    expect(exchangeBodies).toHaveLength(0);
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'refused', reason: 'live_source_price_deviation' });
    expect(raw.mock.calls.some(([url]) => String(url).includes('privy.io'))).toBe(false);
  });
});
