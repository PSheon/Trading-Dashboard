import { CopyLiveApiSettlementRepository } from '../src/copy/live-worker/copy-live-api-settlement.repository.js';
import { apiSettlementProvider } from '../src/copy/live-worker/copy-live-api-settlement.provider.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { testConfig } from './config-test-utils.js';
import { liveCopyMandateIntentSchema } from '@trading-dashboard/shared/contracts';
import { generateKeyPairSync } from 'node:crypto';
import pg, { Pool } from 'pg';
import { PostgresLivePreparation } from '../src/copy/live/postgres-live-preparation.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
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
import { LiveExecutionRuntime } from '../src/copy/live/live-execution-runtime.js';
import { CopyFollowerLedger } from '../src/copy/live/copy-follower-ledger.js';
import { HyperliquidFollowerReceiptReader } from '../src/copy/live/follower-receipt-reader.js';
import { CopyFollowerReconciler } from '../src/copy/copy-follower-monitor.service.js';
import { CopyFollowerScanRepository } from '../src/copy/copy-follower-scan.repository.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { CopyLiveEngine } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveSettler } from '../src/copy/live-worker/copy-live-settler.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import { CopyLiveManualCloser, CopyLiveStopper } from '../src/copy/live-worker/copy-live-stopper.js';
import { CopyLiveFlatCarry } from '../src/copy/live-worker/copy-live-flat-carry.js';
import { CopyLiveCloseService } from '../src/copy/copy-live-close.service.js';
import { CopyLiveCloseRepository } from '../src/copy/copy-live-close.repository.js';
import { CopyLiveStopWorkerRepository } from '../src/copy/live-worker/copy-live-stop-worker.repository.js';
import { ReduceOnlyCloser } from '../src/copy/live-worker/reduce-only-closer.js';
import { CopyLiveStopService } from '../src/copy/copy-live-stop.service.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';
import { resetLiveReadCaches } from '../src/copy/live/live-read-cache.js';
import { liveSourceDigest } from '../src/copy/live/copy-live-source-evidence.js';
import { Dec } from '../src/common/decimal/dec.js';
import { liveSettlementProofCacheStats } from '../src/copy/live/live-settlement-proof.js';

// Only native network endpoints are doubles (Privy, Hyperliquid REST/WS).
// The engine, runtime, risk, journal, reservation, receipt ledger and
// settlement are the production classes on a real database.
const shared = vi.hoisted(() => ({ clock: 0, position: '0', eth: '0', withdrawable: '80', privyDown: 0, dexes: 0, fillCap: '' }));
/** Listed HIP-3 venues besides the main one (testnet lists about 300). */
const venues = () => Array.from({ length: shared.dexes }, (_, i) => `d${i}`);
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
        const size = shared.position, held = [['BTC', size], ['ETH', shared.eth]].filter(([, v]) => v !== '0') as [string, string][];
        const notional = String(held.reduce((n, [, v]) => n + Math.abs(Number(v)) * 100, 0)), margin = String(held.reduce((n, [, v]) => n + Math.abs(Number(v)) * 10, 0));
        const sums = { accountValue: shared.withdrawable === '0' && !held.length ? '0' : '100', totalNtlPos: notional, totalRawUsd: String((shared.withdrawable === '0' && !held.length ? 0 : 100) - Number(notional)), totalMarginUsed: margin };
        const assetPositions = held.map(([coin, szi]) => ({ type: 'oneWay', position: { coin, szi, entryPx: '100', positionValue: String(Math.abs(Number(szi)) * 100), unrealizedPnl: '0',
          marginUsed: String(Math.abs(Number(szi)) * 10), maxLeverage: 20, leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }));
        const state = { marginSummary: sums, crossMarginSummary: sums, crossMaintenanceMarginUsed: '0', withdrawable: shared.withdrawable, time: Date.now(), assetPositions };
        const zero = { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' };
        const empty = { marginSummary: zero, crossMarginSummary: zero, crossMaintenanceMarginUsed: '0', withdrawable: '0', time: Date.now(), assetPositions: [] };
        this.emit('message', Buffer.from(JSON.stringify(subscription.type === 'allDexsClearinghouseState'
          ? { channel: subscription.type, data: { user: subscription.user, clearinghouseStates: [['', state], ...venues().map(dex => [dex, empty])] } }
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
let raw: ReturnType<typeof vi.fn<typeof fetch>>, exchangeBodies: unknown[];
let placedOrders: { oid: number; cloid: string; p: string; s: string; f: string; side: string; r: boolean; at: number; coin: string }[] = [];
// The actual clock throughout: the shared egress quota checks deadlines against it.
const clock = () => Date.now();
/** O10b: the single-position closer ends a flat close without resetting the
 * coin's carry (as one before 2c-B, or any close that left it flat unreset). */
let missedFlatReset = false;

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
  shared.clock = Date.now(); shared.position = '0'; shared.eth = '0'; shared.withdrawable = '80'; shared.privyDown = 0; shared.dexes = 0; shared.fillCap = ''; logs = []; exchangeBodies = []; placedOrders = []; missedFlatReset = false;
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
  await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'pending', controlRevision: 0, requestedAt: date(now - 2000) });
  await db.insert(schema.copyFundingOperations).values({ id: 'fund', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'fund-key-0000000001', network: 'testnet',
    address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '100', nonce: 1, status: 'credited', claimedAt: date(now - 9000), attemptedAt: date(now - 9000),
    evidenceHash: 'a'.repeat(64), transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '100', fee: '0' });
  await db.insert(schema.fillCoverage).values({ address: leader, verifiedFrom: date(now - 10_000), verifiedThrough: date(now + 60_000), backfillFloor: date(now - 10_000) });
  raw = vi.fn<typeof fetch>(async (url, init) => providers(String(url), init?.body ? JSON.parse(String(init.body)) : undefined));
  global = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: 'e2e-shared-egress', ownerId: 'e2e' }, raw);
  vi.stubGlobal('fetch', raw);
});

const meta = { collateralToken: 7, universe: [{ name: 'BTC', szDecimals: 2, maxLeverage: 20 }, { name: 'ETH', szDecimals: 2, maxLeverage: 20 }] };
async function providers(endpoint: string, body: Record<string, unknown> | undefined): Promise<Response> {
  if (endpoint === 'https://api.privy.io/v1/wallets/agent') return Response.json({ id: 'agent', chain_type: 'ethereum', address: agent.address, owner_id: 'owner', archived_at: null });
  if (endpoint === 'https://api.privy.io/v1/wallets/agent/rpc') {
    if (shared.privyDown > 0) { shared.privyDown -= 1; return new Response('upstream unavailable', { status: 503 }); }
    const typed = (body as { params: { typed_data: Record<string, unknown> & { primary_type: string } } }).params.typed_data;
    return Response.json({ method: 'eth_signTypedData_v4', data: { encoding: 'hex', signature: await agent.signTypedData({ ...typed, primaryType: typed.primary_type } as unknown as TypedDataDefinition) } });
  }
  if (endpoint === 'https://api.hyperliquid-testnet.xyz/exchange') {
    exchangeBodies.push(body); const order = (body as { action: { orders: { a: number; c: string; p: string; s: string; b: boolean; r: boolean }[] } }).action.orders[0]!;
    // An IOC fills in full, or only `fillCap` of it once (then cancelled).
    const f = shared.fillCap && Dec.from(shared.fillCap).lt(Dec.from(order.s)) ? shared.fillCap : order.s; shared.fillCap = '';
    const placed = { oid: 77 + placedOrders.length, cloid: order.c, p: order.p, s: order.s, f, side: order.b ? 'B' : 'A', r: order.r, at: Date.now(), coin: meta.universe[order.a]!.name };
    placedOrders.push(placed);
    const net = (coin: string) => Dec.sum(placedOrders.filter(o => o.coin === coin).map(o => Dec.from(o.f).mul(o.side === 'B' ? 1 : -1))).toString();
    shared.position = net('BTC'); shared.eth = net('ETH');
    return Response.json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: placed.oid, totalSz: f, avgPx: '100' } }] } } });
  }
  expect(endpoint).toBe('https://api.hyperliquid-testnet.xyz/info');
  const user = body!.user, status = placedOrders.find(o => o.cloid === body!.oid);
  const values: Record<string, unknown> = { userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false,
    spotClearinghouseState: { portfolioMarginEnabled: false, balances: [] }, perpDexs: [null, ...venues().map(name => ({ name }))], spotMeta: { tokens: [{ index: 7, name: 'USDC', isCanonical: true }] },
    meta, allPerpMetas: [meta, ...venues().map(dex => ({ collateralToken: 7, universe: [{ name: `${dex}:X`, szDecimals: 2, maxLeverage: 10 }] }))], metaAndAssetCtxs: [meta, [{ midPx: '100', markPx: '100' }, { midPx: '100', markPx: '100' }]], allMids: { BTC: '100', ETH: '100' },
    activeAssetData: { user, coin: body!.coin ?? 'BTC', leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['1', '1'], availableToTrade: ['100', '100'], markPx: '100' },
    userFees: { userAddRate: '-0.0001', userCrossRate: '0.0005', activeReferralDiscount: '0', trial: null },
    extraAgents: [{ address: agent.address, name: 'dedicated', validUntil: Date.now() + 60000 }],
    orderStatus: status ? { status: 'order', order: { status: status.f === status.s ? 'filled' : 'canceled', statusTimestamp: status.at + 2, order: { coin: status.coin, oid: status.oid, cloid: status.cloid, side: status.side, reduceOnly: status.r,
      tif: 'Ioc', origSz: status.s, sz: Dec.from(status.s).sub(Dec.from(status.f)).toString(), limitPx: status.p, timestamp: status.at, isTrigger: false, isPositionTpsl: false, children: [] } } } : { status: 'unknownOid' },
    userFillsByTime: placedOrders.map((o, i) => ({ coin: o.coin, px: '100', sz: o.f, side: o.side, time: o.at + 1, startPosition: '0', dir: 'Open Long', closedPnl: '0',
      hash: `0x${String(34 + i).repeat(32)}`, oid: o.oid, crossed: true, fee: '0.01', tid: 501 + i, feeToken: 'USDC' }))
      .filter(fill => (typeof body!.startTime !== 'number' || fill.time >= body!.startTime) && (typeof body!.endTime !== 'number' || fill.time <= body!.endTime)), userFunding: [] };
  if (!(String(body!.type) in values)) throw Error(`Unsupported offline INFO ${String(body!.type)}`);
  return Response.json(values[String(body!.type)]);
}
function engine(midPrice = '100', egress = global, withStopper = false, apiTerminalSettlement = false, settleEgress = 'e2e-settle-egress') {
  // Settlement right after the order (scan 240 + status + account ~630): an
  // order and its settlement exceed one minute's 1200 testnet weight, so in
  // production settlement waits for a later pass; here it gets its own room.
  const settleGlobal = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: settleEgress, ownerId: `${settleEgress}-owner` }, raw);
  const settleBudget = new RequestBudgeterService(new AppConfig({ ...config.value, hyperliquid: { ...config.value.hyperliquid, budgetPerMin: 200, burst: 1000 } }));
  const reference = { network: 'mainnet' as const, read: vi.fn(async () => ({ midPrice, midObservedAt: Date.now(), leaderEquity: null, leaderEquityObservedAt: null })) };
  const options = { slippageBps: '30', extraRiskBufferBps: '5', restingOrderBuilderFeeCapTenthsBps: 100, maxSourceDeviationBps: '500' };
  const stops = new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), testConfig()), closer = new ReduceOnlyCloser('testnet', pool, db, new UnitOfWork(db), config, egress, budget, 100, clock);
  const stopOnly = new CopyLiveStopper({ repository: stops, canceller: null, swept: async () => false, closer, log: message => logs.push(message) }, clock);
  const manual = new CopyLiveManualCloser(stops, closer, new CopyFollowerReconciler(new CopyFollowerScanRepository(db, testConfig()), new CopyFollowerLedger(db, new UnitOfWork(db)),
    new HyperliquidFollowerReceiptReader('testnet', weight => budget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) }), egress.fetchInfo, clock)),
    missedFlatReset ? { owed: async () => [], reset: async () => true } : new CopyLiveFlatCarry('testnet', pool, clock), message => logs.push(message));
  const stopper = withStopper ? { tick: async () => { await stopOnly.tick(); await manual.tick(); } } : undefined;
  return new CopyLiveEngine({ stopper, apiTerminalSettlement,
    network: 'testnet', repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db, clock), testnetSource: { read: vi.fn() } as never,
    runtime: hooks => new LiveExecutionRuntime('testnet', pool, config, egress, budget, options, clock, { ...hooks, reference }),
    settler: new CopyLiveSettler('testnet', pool, settleGlobal, settleBudget, new CopyFollowerReconciler(new CopyFollowerScanRepository(db, testConfig()), new CopyFollowerLedger(db, new UnitOfWork(db)),
      new HyperliquidFollowerReceiptReader('testnet', weight => settleBudget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) }), settleGlobal.fetchInfo, clock)), clock), log: message => logs.push(message),
  }, { testnetSourceIntervalMs: 60_000, sourceLagMs: 0, passBudgetMs: 60_000 }, clock);
}
async function leaderOpens(tid = 1001, coin = 'BTC', side: 'B' | 'A' = 'B', sz = '1', startPosition = '0', dir = 'Open Long') {
  await new Promise(resolve => setTimeout(resolve, 5));
  const time = Date.now() - 2, rawFill = { coin, px: '100', sz, side, time, startPosition, dir, closedPnl: '0',
    hash: `0x${'12'.repeat(32)}`, oid: 1000 + tid, crossed: true, fee: '0.01', tid, feeToken: 'USDC' };
  await db.insert(schema.fills).values({ address: leader, tid: BigInt(tid), coin, side, dir, px: '100', sz, fee: '0.01', hash: rawFill.hash, ts: new Date(time), raw: rawFill });
}
/** A leader fill on BTC: an add to its long, or a close of `sz` of it. */
async function leaderTrades(tid: number, dir: 'Open Long' | 'Close Long', sz: string, startPosition: string) {
  await new Promise(resolve => setTimeout(resolve, 5));
  const side = dir === 'Open Long' ? 'B' : 'A', time = Date.now() - 2, rawFill = { coin: 'BTC', px: '100', sz, side, time, startPosition, dir, closedPnl: '0',
    hash: `0x${'12'.repeat(32)}`, oid: 1000 + tid, crossed: true, fee: '0.01', tid, feeToken: 'USDC' };
  await db.insert(schema.fills).values({ address: leader, tid: BigInt(tid), coin: 'BTC', side, dir, px: '100', sz, fee: '0.01', hash: rawFill.hash, ts: new Date(time), raw: rawFill });
}

describe('testnet copy of a mainnet leader, end to end against provider doubles', { timeout: 30_000 }, () => {
  it('settles terminal proof within five seconds despite slow independent metadata and status reads', async () => {
    const e = engine();
    await e.tick(); await leaderOpens(); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'submitted' });
    raw.mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.type === 'meta' || body?.type === 'orderStatus') await new Promise(resolve => setTimeout(resolve, 1700));
      return providers(String(url), body);
    });
    const account = HyperliquidLiveAccountObserver.prototype.observe;
    vi.spyOn(HyperliquidLiveAccountObserver.prototype, 'observe').mockImplementation(async function (this: HyperliquidLiveAccountObserver, ...args) {
      await new Promise(resolve => setTimeout(resolve, 2100));
      return account.apply(this, args);
    });
    await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled', reason: null });
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]).toMatchObject({ state: 'released', releaseReason: 'verified_settlement' });
    expect(exchangeBodies).toHaveLength(1);
  });
  it('retains the original liability when batched terminal metadata is unavailable', async () => {
    const e = engine();
    await e.tick(); await leaderOpens(); await e.tick();
    raw.mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return body?.type === 'meta' ? new Response('offline unavailable', { status: 503 }) : providers(String(url), body);
    });
    await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'submitted' });
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]?.state).not.toBe('released');
    expect(exchangeBodies).toHaveLength(1);
  });
  it('does not release or resend when a batched terminal provider read exceeds five seconds', async () => {
    const e = engine();
    await e.tick(); await leaderOpens(); await e.tick();
    raw.mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.type === 'orderStatus') await new Promise(resolve => setTimeout(resolve, 5100));
      return providers(String(url), body);
    });
    await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'submitted' });
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]?.state).not.toBe('released');
    expect(exchangeBodies).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 200));
  });
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
  it('admits original terminal receipt proof from protected live weight while ordinary reads exhaust the main bucket', async () => {
    const e = engine('100', global, false, true);
    await e.tick(); await leaderOpens(); await e.tick(); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'submitted' });
    const apiPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    const apiConfig = new AppConfig({ ...config.value, hyperliquid: { ...config.value.hyperliquid, budgetPerMin: 400, burst: 800 } });
    const apiBudget = new RequestBudgeterService(apiConfig), jobs = new BackgroundJobs();
    const apiTransport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(apiPool, { schema }))),
      { egressKey: 'e2e-shared-egress', ownerId: 'e2e-api-priority' }, raw);
    const api = await apiSettlementProvider.useFactory(apiConfig, apiPool, { network: 'testnet', budget: apiBudget, transport: apiTransport, config: apiConfig }, jobs);
    let running: Promise<void> | undefined;
    try {
      // A reporting pass has consumed the background allowance. The protected
      // live reserve still has enough for the original terminal receipt pass.
      await apiBudget.acquire(288, 'background');
      const before = exchangeBodies.length, nonces = await db.select().from(schema.copySignerNonces);
      raw.mockClear(); running = api.tick();
      await vi.waitFor(() => expect(raw.mock.calls.some(([, init]) =>
        init?.body && JSON.parse(String(init.body)).type === 'userFillsByTime')).toBe(true), { timeout: 1500, interval: 10 });
      await running;
      expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled', attempts: 1 });
      expect((await db.select().from(schema.copyLiveRiskReservations))[0]).toMatchObject({ state: 'released', releaseReason: 'verified_settlement' });
      expect(await db.select().from(schema.copyFollowerReceipts)).toHaveLength(1);
      expect(exchangeBodies).toHaveLength(before);
      expect(await db.select().from(schema.copySignerNonces)).toEqual(nonces);
    } finally { api.onModuleDestroy(); await running; apiBudget.onModuleDestroy(); await apiPool.end(); }
  });
  it.each([false, true])('API terminal settlement uses its existing wallet budget, books receipts and replays after a crash (stopped old generation %s)', async stopped => {
    const e = engine('100', global, false, true);
    await e.tick(); await leaderOpens(); await e.tick(); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'submitted' });
    const [heldReservation] = await db.select().from(schema.copyLiveRiskReservations);
    await db.update(schema.copyLiveRiskReservations).set({ network: 'mainnet' }).where(eq(schema.copyLiveRiskReservations.key, heldReservation!.key));
    await expect(new CopyLiveApiSettlementRepository(db).load(heldReservation!.key)).rejects.toThrow('live_settlement_claim_identity');
    await db.update(schema.copyLiveRiskReservations).set({ network: 'testnet' }).where(eq(schema.copyLiveRiskReservations.key, heldReservation!.key));
    if (stopped) {
      const [m] = await db.select().from(schema.copyLiveMandates);
      const stopService = new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())), new UnitOfWork(db));
      await stopService.request(1, 'mandate', { idempotencyKey: 'terminal-held-stop-key', expectedMandateRevision: m!.revision });
      const [barrier] = await db.select().from(schema.copyLiveStopOperations);
      expect(barrier!.targetManifest.executions).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'filled', reservationState: 'unknown' })]));
      expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.state).not.toBe('released');
      await db.update(schema.copyLiveMandates).set({ state: 'expired' });
      await db.update(schema.copyStrategies).set({ status: 'stopped', stoppedAt: new Date() });
    }
    const apiPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    const apiConfig = new AppConfig({ ...config.value, hyperliquid: { ...config.value.hyperliquid, budgetPerMin: 400, burst: 800 } });
    const apiBudget = new RequestBudgeterService(apiConfig), jobs = new BackgroundJobs();
    const apiTransport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(apiPool, { schema }))),
      { egressKey: 'e2e-shared-egress', ownerId: 'e2e-api' }, raw);
    const api = await apiSettlementProvider.useFactory(apiConfig, apiPool, { network: 'testnet', budget: apiBudget, transport: apiTransport, config: apiConfig }, jobs);
    try {
      const before = exchangeBodies.length, nonces = await db.select().from(schema.copySignerNonces);
      raw.mockClear();
      const provider = raw.getMockImplementation()!;
      let entered!: () => void, unblock!: () => void;
      const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { unblock = resolve; });
      let paused = false;
      raw.mockImplementation(async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (!paused && body?.type === 'userFillsByTime') { paused = true; entered(); await held; }
        return provider(url, init);
      });
      const first = api.tick(); await observed;
      const paid = raw.mock.calls.length;
      const replica = await apiSettlementProvider.useFactory(apiConfig, apiPool, { network: 'testnet', budget: apiBudget, transport: apiTransport, config: apiConfig }, jobs);
      await replica.tick(); replica.onModuleDestroy();
      expect(raw.mock.calls.length).toBe(paid);
      unblock(); await first;
      const [dispatch] = await db.select().from(schema.copyLiveDispatches);
      expect(dispatch).toMatchObject({ state: 'settled', attempts: 1 });
      expect((await db.select().from(schema.copyLiveRiskReservations))[0]).toMatchObject({ state: 'released', releaseReason: 'verified_settlement' });
      expect(await db.select().from(schema.copyFollowerReceipts)).toHaveLength(1);
      expect(await db.select().from(schema.copyFollowerObservations)).toHaveLength(1);
      expect(raw.mock.calls.every(([url]) => String(url).endsWith('/info'))).toBe(true);
      expect(exchangeBodies).toHaveLength(before);
      expect(await db.select().from(schema.copySignerNonces)).toEqual(nonces);
      await db.update(schema.copyLiveDispatches).set({ state: 'submitted' }).where(eq(schema.copyLiveDispatches.id, dispatch!.id));
      raw.mockClear(); await api.tick();
      expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled', attempts: 1 });
      expect(raw).not.toHaveBeenCalled();
      expect(await db.select().from(schema.copySignerNonces)).toEqual(nonces);
    } finally { api.onModuleDestroy(); apiBudget.onModuleDestroy(); await apiPool.end(); }
  });
  it('recovers a dispatch interrupted after committed settlement without provider reads or another order', async () => {
    const e = engine(); await e.tick(); await leaderOpens(); await e.tick();
    await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    const [dispatch] = await db.select().from(schema.copyLiveDispatches);
    expect(dispatch).toMatchObject({ state: 'settled', attempts: 1 });
    const reservations = await db.select().from(schema.copyLiveRiskReservations);
    const evidence = await db.select().from(schema.copyLiveExecutionEvidence);
    const receipts = await db.select().from(schema.copyFollowerReceipts);
    await db.update(schema.copyLiveDispatches).set({ state: 'submitted' }).where(eq(schema.copyLiveDispatches.id, dispatch!.id));
    raw.mockClear();
    raw.mockImplementation(async () => { throw new Error('released settlement recovery must not access providers'); });
    await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled', reason: null, attempts: 1 });
    expect(raw).not.toHaveBeenCalled();
    expect(await db.select().from(schema.copyLiveRiskReservations)).toEqual(reservations);
    expect(await db.select().from(schema.copyLiveExecutionEvidence)).toEqual(evidence);
    expect(await db.select().from(schema.copyFollowerReceipts)).toEqual(receipts);
    expect(exchangeBodies).toHaveLength(1);
    expect(await db.select().from(schema.copySignerNonces)).toHaveLength(1);
  });
  it('after a settled order the next leader open is sized from the projected position and also settles', async () => {
    let e = engine(); await e.tick(); await leaderOpens(1001); await e.tick(); await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled' });
    // A minute of testnet weight is spent; the next order runs on fresh quota (production: the next minute).
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config);
    e = engine('100', new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: 'e2e-second-egress', ownerId: 'e2e-2' }, raw));
    await leaderOpens(1002); await e.tick();
    expect(logs).toEqual([]); expect(exchangeBodies).toHaveLength(2);
    expect(exchangeBodies[1]).toMatchObject({ action: { orders: [{ b: true, s: '0.19', r: false }] } });
    await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    const rows = await db.select().from(schema.copyLiveDispatches);
    expect(rows.map(r => r.state)).toEqual(['settled', 'settled']);
    expect(await db.select().from(schema.copyFollowerReceipts)).toHaveLength(2);
  });
  it('after a settled order the leader opens another coin: it is planned and settles too (Stage mainnet 2026-10-12, BTC after SOL)', async () => {
    // The second coin's carry is seeded during planning: at a time after the
    // manifest's check it failed the generation proof (live_generation_unproven).
    let e = engine(); await e.tick(); await leaderOpens(1001); await e.tick(); await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled' });
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config);
    e = engine('100', new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: 'e2e-second-coin-egress', ownerId: 'e2e-3' }, raw));
    await leaderOpens(1002, 'ETH'); await e.tick();
    expect(logs.filter(l => l.includes('live_generation_unproven'))).toEqual([]);
    expect(exchangeBodies).toHaveLength(2);
    expect(exchangeBodies[1]).toMatchObject({ action: { orders: [{ a: 1, b: true, r: false }] } });
    await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches)).map(r => r.state)).toEqual(['settled', 'settled']);
    expect((await db.select().from(schema.copyLiveReductionCarry)).map(r => r.coin).sort()).toEqual(['BTC', 'ETH']);
  });
  it('a leader flip of a long it opened before this copy: nothing to close, the follower opens the short and it settles', async () => {
    const e = engine(); await e.tick();
    // Long 2 before the copy's activation, then a sell of 3: a close leg (nothing
    // for the follower to close) and an open of a short 1.
    await leaderOpens(1001, 'BTC', 'A', '3', '2', 'Long > Short'); await e.tick(); await e.tick();
    let rows = await db.select().from(schema.copyLiveDispatches);
    expect(rows.find(r => r.leg === 'close')).toMatchObject({ state: 'refused', reason: 'no_follower_position' });
    expect(rows.find(r => r.leg === 'open')!.reason).not.toBe('flip_close_not_settled');
    expect(exchangeBodies).toHaveLength(1);
    expect(exchangeBodies[0]).toMatchObject({ action: { orders: [{ b: false, r: false }] } });
    await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    rows = await db.select().from(schema.copyLiveDispatches);
    expect(rows.find(r => r.leg === 'open')).toMatchObject({ state: 'settled' });
    // Its leg still names the flip's close (never journaled, left planned).
    const legs = await db.select().from(schema.copyLiveSignalLegs), close = legs.find(l => l.leg === 'close');
    expect(close).toMatchObject({ state: 'planned', executionKey: null });
    expect(legs.find(l => l.leg === 'open')).toMatchObject({ state: 'settled', dependsOnId: close!.id });
  });
  it('thirty settled orders later the copy still opens and closes: each envelope keeps settled proofs by digest, far below 2 MiB (testnet-sized snapshots)', { timeout: 600_000 }, async () => {
    // About 300 listed venues make a testnet account snapshot ~95 KB. Each
    // settled order's proof holds one; inline in every later envelope they
    // reached the 2 MiB bound after ~16 orders and every order failed after.
    shared.dexes = 300; resetLiveReadCaches(); // the venue list and metas earlier tests cached
    // Room for thirty orders: the grant and its setup (equal expiry) and the leader's coverage.
    const until = new Date(Date.now() + 900_000);
    await db.update(schema.copyWalletAuthorizations).set({ expiresAt: until });
    await db.update(schema.copyAgentSetups).set({ expiresAt: until });
    await db.update(schema.fillCoverage).set({ verifiedThrough: until });
    const [mandate] = await db.select().from(schema.copyLiveMandates), intent = liveCopyMandateIntentSchema.parse({ ...mandate!.intent, expiresAt: until.getTime() });
    await db.update(schema.copyLiveMandates).set({ intent, intentDigest: mandateDigest(intent), expiresAt: until });
    let e = engine(); await e.tick();
    const sizes: number[] = [], prepared: number[] = [], assessed: number[] = [];
    for (let i = 0; i < 30; i++) {
      budget.onModuleDestroy(); budget = new RequestBudgeterService(config);
      e = engine('100', new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: `e2e-many-${i}`, ownerId: `e2e-many-${i}` }, raw), false, false, `e2e-many-settle-${i}`);
      if (i % 2 === 0) await leaderOpens(2000 + i); else await leaderOpens(2000 + i, 'BTC', 'A', '1', '1', 'Close Long');
      const assessments = liveSettlementProofCacheStats().assessments, started = Date.now(); await e.tick(); prepared.push(Date.now() - started);
      let rows = await db.select().from(schema.copyLiveDispatches).orderBy(schema.copyLiveDispatches.leaderTime);
      for (let pass = 0; pass < 5 && rows.some(r => r.state !== 'settled'); pass++) {
        await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
        rows = await db.select().from(schema.copyLiveDispatches).orderBy(schema.copyLiveDispatches.leaderTime);
      }
      assessed.push(liveSettlementProofCacheStats().assessments - assessments);
      expect(rows.map(r => [r.leg, r.state, r.reason])).toEqual(Array.from({ length: i + 1 }, (_, n) => [n % 2 ? 'close' : 'open', 'settled', null]));
      const [latest] = await db.select().from(schema.copyLiveIntentProvenance).orderBy(desc(schema.copyLiveIntentProvenance.admittedAt)).limit(1);
      sizes.push(Buffer.byteLength(JSON.stringify(latest!.sizingBasis)));
      // The settled orders' proofs are named by digest only; each row stores its envelope's digest.
      const retained = (latest!.sizingBasis as { observations: { generationManifest: { journals: { evidence: Record<string, unknown> | null }[] } } }).observations.generationManifest.journals;
      expect(retained.filter(j => j.evidence?.settlementProofDigest)).toHaveLength(i);
      expect(retained.every(j => !j.evidence || !('settlementProof' in j.evidence))).toBe(true);
      expect(latest!.sizingBasisDigest).toBe(liveSourceDigest(latest!.sizingBasis));
    }
    expect(exchangeBodies).toHaveLength(30);
    expect(logs.filter(l => l.includes('failed'))).toEqual([]);
    expect(Math.max(...sizes)).toBeLessThan(1024 * 1024);
    // Each later order adds only its compact journal entry and receipts, not a snapshot.
    expect((sizes[29]! - sizes[1]!) / 28).toBeLessThan(20_000);
    expect(Math.max(...prepared.slice(-5))).toBeLessThan(10_000);
    // Growth guard: an order assesses only its own settlement proof in full
    // (captured at settlement, verified on its first use), flat from order 5
    // to order 30. Every projection used to re-assess every earlier proof
    // (~14 projections an order) until orders outlived the 5 s evidence window.
    expect(Math.max(...assessed.slice(5))).toBeLessThanOrEqual(Math.min(2, assessed[5]!));
    shared.dexes = 0; resetLiveReadCaches();
  });
  it('an order sends at most 150 database round trips (950 statements) from its preparation to its POST, and no row lock before BEGIN\'s answer or the reads sent behind it', { timeout: 120_000 }, async () => {
    // Its evidence is never older than its preparation's start, so the
    // statements from there to the exchange POST bound the round trips that
    // the 5 s evidence window (and the pre-mainnet gate's 3500 ms) must
    // hold: each costs Stage ~8 ms (2026-10-12: ~1,000 of them, one per
    // round trip, live_risk_stale at 6977 ms). A statement is a new round
    // trip unless it goes out pipelined behind one still in flight.
    shared.dexes = 300; resetLiveReadCaches(); // testnet-sized: three account sockets
    const prepare = PostgresLivePreparation.prototype.prepare, original = pg.Client.prototype.query, inflight = new WeakMap<object, number>();
    let counting = false, statements = 0, roundTrips = 0;
    const orders: { statements: number; roundTrips: number }[] = [];
    vi.spyOn(PostgresLivePreparation.prototype, 'prepare').mockImplementation(function (this: PostgresLivePreparation, ...args) {
      counting = true; statements = 0; roundTrips = 0; return prepare.apply(this, args);
    });
    raw.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/exchange') && counting) { counting = false; orders.push({ statements, roundTrips }); }
      return providers(String(url), init?.body ? JSON.parse(String(init.body)) : undefined);
    });
    // Every pipelined transaction (hold, reservation, journal, meter, the
    // authority loaders, all on the risk scope's session): a row lock (FOR
    // UPDATE / NO KEY UPDATE / SHARE / KEY SHARE) goes out only once BEGIN has
    // answered and every read sent behind the unanswered BEGIN (the batch
    // whose answers prove the identity the later statements are keyed by)
    // has answered. Before that, a BEGIN that failed leaves the lock outside
    // any transaction (without its timeouts), and a lock keyed by an unproven
    // identity has already been taken.
    const rowLock = /\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/i;
    const transactions = new WeakMap<object, { answered: boolean; early: Set<number>; pending: Set<number> }>();
    const rowLocks: { text: string; answered: boolean; pendingEarlyReads: number }[] = [];
    let sequence = 0;
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      const busy = inflight.get(this) ?? 0, pipelined = (this as unknown as { pipeline?: boolean }).pipeline === true;
      if (counting) { statements++; if (!pipelined || busy === 0) roundTrips++; }
      const text = String(typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | null)?.text ?? '').trim();
      const transaction = transactions.get(this), id = sequence++;
      if (pipelined && transaction && rowLock.test(text)) rowLocks.push({ text, answered: transaction.answered, pendingEarlyReads: [...transaction.early].filter(read => transaction.pending.has(read)).length });
      const result = (original as (...values: unknown[]) => unknown).apply(this, args) as Promise<unknown> | undefined;
      if (result && typeof result.then === 'function') {
        inflight.set(this, busy + 1);
        const done = () => { inflight.set(this, (inflight.get(this) ?? 1) - 1); };
        void result.then(done, done);
        if (pipelined && /^begin\b/i.test(text)) {
          const opened = { answered: false, early: new Set<number>(), pending: new Set<number>() };
          transactions.set(this, opened);
          const answer = () => { opened.answered = true; };
          void result.then(answer, answer);
        } else if (pipelined && transaction && /^(commit|rollback)\b/i.test(text)) transactions.delete(this);
        else if (pipelined && transaction && /^select\b/i.test(text) && !rowLock.test(text) && !text.includes('from pg_locks') && !text.includes('set_config(')) {
          transaction.pending.add(id); if (!transaction.answered) transaction.early.add(id);
          const answered = () => { transaction.pending.delete(id); };
          void result.then(answered, answered);
        }
      }
      return result;
    } as typeof original;
    try {
      let e = engine(); await e.tick();
      for (const [i, close] of [[0, false], [1, true]] as const) {
        budget.onModuleDestroy(); budget = new RequestBudgeterService(config);
        e = engine('100', new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: `e2e-trips-${i}`, ownerId: `e2e-trips-${i}` }, raw), false, false, `e2e-trips-settle-${i}`);
        if (close) await leaderOpens(3001, 'BTC', 'A', '1', '1', 'Close Long'); else await leaderOpens(3000);
        await e.tick();
        for (let pass = 0; pass < 5 && (await db.select().from(schema.copyLiveDispatches)).some(r => r.state !== 'settled'); pass++) {
          await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
        }
      }
    } finally { pg.Client.prototype.query = original; shared.dexes = 0; resetLiveReadCaches(); }
    expect((await db.select().from(schema.copyLiveDispatches)).map(r => [r.leg, r.state])).toEqual([['open', 'settled'], ['close', 'settled']]);
    process.stdout.write(`order database round trips, preparation to POST: ${JSON.stringify(orders)}\n`);
    expect(orders).toHaveLength(2);
    for (const order of orders) { expect(order.roundTrips).toBeLessThanOrEqual(150); expect(order.statements).toBeLessThanOrEqual(950); }
    // The pipelined transactions that lock rows ran: the hold and the journal
    // save (the journal row), the preparation (the order's leg), the meter
    // (the quota row).
    for (const table of ['copy_live_executions', 'copy_live_signal_legs', 'hyperliquid_egress_quota'])
      expect(rowLocks.some(lock => lock.text.includes(`"${table}"`))).toBe(true);
    expect(rowLocks.filter(lock => !lock.answered || lock.pendingEarlyReads > 0)).toEqual([]);
  });
  it('waits six seconds for close evidence quota before observing and still sends only the fresh reduce-only position', async () => {
    // A cold cross-order read cache: the close pays its full observation (> 284).
    resetLiveReadCaches();
    shared.position = '0.19';
    const acquire = RequestBudgeterService.prototype.acquire.bind(budget);
    let waited = false, marketReads = 0;
    vi.spyOn(budget, 'acquire').mockImplementation(async (weight, ...rest) => {
      await acquire(weight, ...rest);
      if (weight === 20) marketReads += 1;
      if (!waited && (marketReads === 2 || weight > 284)) { waited = true; await new Promise(resolve => setTimeout(resolve, 6000)); }
    });
    const closer = new ReduceOnlyCloser('testnet', pool, db, new UnitOfWork(db), config, global, budget, 100, clock);
    const result = await closer.close({ account: { userId: 1, strategyId: 9, accountId: 'account', accountAddress: seed.f.identity.accountAddress,
      authorizationId: 'grant', walletId: 'agent', workerQuorumId: 'worker' }, coin: 'BTC', seed: 'local-quota-close', stillWanted: async () => true });
    expect(waited).toBe(true); expect(result?.state).toBe('filled');
    expect(exchangeBodies).toHaveLength(1);
    expect(exchangeBodies[0]).toMatchObject({ action: { orders: [{ b: false, s: '0.19', r: true, t: { limit: { tif: 'Ioc' } } }] } });
  });
  it('a stop closes the copied position with one agent-signed reduce-only IOC, confirms flat and ends the copy when nothing is left', async () => {
    let e = engine(); await e.tick(); await leaderOpens(1001); await e.tick(); await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled' });
    const [mandate] = await db.select().from(schema.copyLiveMandates);
    await new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())), new UnitOfWork(db))
      .request(1, 'mandate', { idempotencyKey: 'e2e-stop-request-0001', expectedMandateRevision: mandate!.revision });
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config);
    e = engine('100', new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: 'e2e-stop-egress', ownerId: 'e2e-stop' }, raw), true);
    await e.tick(); // requested -> closing
    await e.tick(); // the reduce-only close
    expect(logs).toEqual([]);
    expect(exchangeBodies).toHaveLength(2);
    expect(exchangeBodies[1]).toMatchObject({ action: { type: 'order', orders: [{ a: 0, b: false, s: '0.19', r: true, t: { limit: { tif: 'Ioc' } } }] } });
    expect(shared.position).toBe('0');
    shared.withdrawable = '0';
    // The next minute's testnet quota (an order, its evidence and the account
    // observations fill one minute's 1200 weight).
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config);
    e = engine('100', new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: 'e2e-flat-egress', ownerId: 'e2e-flat' }, raw), true);
    await e.tick(); // flat
    const [flat] = await db.select().from(schema.copyLiveStopOperations);
    expect(flat).toMatchObject({ state: 'flat' }); expect(flat!.flatDigest).toMatch(/^[0-9a-f]{64}$/);
    await e.tick(); // nothing left to return
    expect((await db.select().from(schema.copyLiveStopOperations))[0]).toMatchObject({ state: 'stopped' });
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'stopped' });
    expect(exchangeBodies).toHaveLength(2);
  });
  it('a stop whose close could not be signed (Privy 5xx) is not wedged on it: the stop shows why and the next pass sends a fresh close', async () => {
    let e = engine(); await e.tick(); await leaderOpens(1001); await e.tick(); await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled' });
    const [mandate] = await db.select().from(schema.copyLiveMandates);
    await new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())), new UnitOfWork(db))
      .request(1, 'mandate', { idempotencyKey: 'e2e-stop-request-0002', expectedMandateRevision: mandate!.revision });
    const fresh = (name: string) => new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: name, ownerId: name }, raw);
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config); e = engine('100', fresh('e2e-stop-privy-down'), true);
    await e.tick(); // requested -> closing
    shared.privyDown = 1;
    await e.tick(); // the close's signature fails: nothing is sent
    expect(exchangeBodies).toHaveLength(1);
    const failed = (await db.select().from(schema.copyLiveStopOperations))[0]!;
    expect(failed).toMatchObject({ state: 'closing' }); expect(failed.issue).not.toBeNull();
    // The unsent close ended (never sent), so it can't hold the stop.
    expect((await db.select().from(schema.copyLiveExecutions)).filter(row => row.state === 'prepared')).toEqual([]);
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config); e = engine('100', fresh('e2e-stop-privy-back'), true);
    await e.tick(); // a fresh close (attempt 1) goes out, at a wider price (1.5 % under the mid instead of 1 %)
    expect(exchangeBodies).toHaveLength(2);
    expect(exchangeBodies[1]).toMatchObject({ action: { type: 'order', orders: [{ a: 0, b: false, p: '98.5', s: '0.19', r: true, t: { limit: { tif: 'Ioc' } } }] } });
    expect(shared.position).toBe('0');
  });
  it('the owner closes one position while copying: a reduce-only IOC by the agent, then the copy keeps mirroring the leader', async () => {
    let e = engine(); await e.tick(); await leaderOpens(1001); await e.tick(); await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled' });
    const close = await new CopyLiveCloseService(new CopyLiveCloseRepository(db, testConfig())).request(1, 'account', { idempotencyKey: '55555555-5555-4555-8555-555555555555', coin: 'BTC' });
    expect(close).toMatchObject({ state: 'requested', coin: 'BTC', orders: 0 });
    const fresh = (name: string) => new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: name, ownerId: name }, raw);
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config); e = engine('100', fresh('e2e-manual-close'), true);
    await e.tick();
    expect(logs).toEqual([]);
    expect(exchangeBodies[1]).toMatchObject({ action: { orders: [{ b: false, s: '0.19', r: true, t: { limit: { tif: 'Ioc' } } }] } });
    expect(shared.position).toBe('0');
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config); e = engine('100', fresh('e2e-manual-done'), true);
    await e.tick();
    expect((await db.select().from(schema.copyLiveManualCloses))[0]).toMatchObject({ state: 'done' });
    // The next leader open still sizes and sends: the projection counts the owner's close.
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config); e = engine('100', fresh('e2e-after-close'));
    await leaderOpens(1002); await e.tick();
    expect(logs).toEqual([]);
    expect(exchangeBodies).toHaveLength(3);
    expect(exchangeBodies[2]).toMatchObject({ action: { orders: [{ b: true, s: '0.19', r: false }] } });
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'active' });
  });
  // 2c-B: what a settled close still owed (its reduction carry) is owed of
  // nothing once a close after the leader went flat left the follower flat.
  // Kept, a later re-open's partial close closed carry + f·(N − carry), not f·N.
  it('after a close left the follower flat, a re-opened position\'s partial close sizes from the new position, not the old carry', async () => {
    const fresh = (name: string) => new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: name, ownerId: name }, raw);
    const pass = async (name: string, stopper = true) => { budget.onModuleDestroy(); budget = new RequestBudgeterService(config); await engine('100', fresh(name), stopper).tick(); };
    const carry = async () => (await db.select().from(schema.copyLiveReductionCarry).where(eq(schema.copyLiveReductionCarry.coin, 'BTC')))[0];
    let e = engine(); await e.tick(); await leaderOpens(1001); await e.tick(); await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    expect(shared.position).toBe('0.19');
    // The leader closes all of it; the follower's IOC fills 0.1 of its 0.19.
    shared.fillCap = '0.1';
    await leaderTrades(1002, 'Close Long', '1', '1'); await pass('e2e-2c-close', false);
    expect(shared.position).toBe('0.09');
    await new Promise(resolve => setTimeout(resolve, 5)); await pass('e2e-2c-settle', false);
    expect((await db.select().from(schema.copyLiveDispatches)).find(r => r.sourceFillId.endsWith(':1002'))).toMatchObject({ leg: 'close', state: 'settled' });
    expect(await carry()).toMatchObject({ carry: '0.09' });
    // The leader is flat: the single-position closer closes the 0.09 left.
    for (let i = 0; i < 4 && (await db.select().from(schema.copyLiveManualCloses))[0]?.state !== 'done'; i++) await pass(`e2e-2c-flat-${i}`);
    expect((await db.select().from(schema.copyLiveManualCloses))[0]).toMatchObject({ state: 'done', idempotencyKey: expect.stringMatching(/^reconcile:/) });
    expect(shared.position).toBe('0');
    // The leader opens again (N = 0.19), then closes 60 % of it: f·N = 0.114 → 0.11.
    await leaderTrades(1003, 'Open Long', '1', '0'); await pass('e2e-2c-reopen', false);
    await new Promise(resolve => setTimeout(resolve, 5)); await pass('e2e-2c-reopen-settle', false);
    expect(shared.position).toBe('0.19');
    await leaderTrades(1004, 'Close Long', '0.6', '1'); await pass('e2e-2c-partial', false);
    expect(logs.filter(l => l.includes('failed'))).toEqual([]);
    expect(exchangeBodies.at(-1)).toMatchObject({ action: { orders: [{ b: false, s: '0.11', r: true }] } });
    expect(shared.position).toBe('0.08');
    await new Promise(resolve => setTimeout(resolve, 5)); await pass('e2e-2c-partial-settle', false);
    expect((await db.select().from(schema.copyLiveDispatches)).find(r => r.sourceFillId.endsWith(':1004'))).toMatchObject({ state: 'settled' });
    expect(await carry()).toMatchObject({ carry: '0.004' });
  });
  // O10b: the open's preparation itself resets the carry of a coin the
  // generation proves flat, whichever close emptied it without resetting it.
  describe('a re-open of a coin left flat with its carry still owed (O10b)', () => {
    const fresh = (name: string) => new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: name, ownerId: name }, raw);
    const pass = async (name: string, stopper = true) => { budget.onModuleDestroy(); budget = new RequestBudgeterService(config); await engine('100', fresh(name), stopper).tick(); };
    const carry = async () => (await db.select().from(schema.copyLiveReductionCarry).where(eq(schema.copyLiveReductionCarry.coin, 'BTC')))[0]!;
    const dispatch = async (tid: number) => (await db.select().from(schema.copyLiveDispatches)).find(r => r.sourceFillId.endsWith(`:${tid}`));
    /** Mirrors the open, a close filled 0.1 of 0.19, then the flat close of the
     * 0.09 left ends done without resetting the carry it owed. */
    async function flatOwing(name: string) {
      const e = engine(); await e.tick(); await leaderOpens(1001); await e.tick(); await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
      shared.fillCap = '0.1';
      await leaderTrades(1002, 'Close Long', '1', '1'); await pass(`${name}-close`, false);
      await new Promise(resolve => setTimeout(resolve, 5)); await pass(`${name}-settle`, false);
      expect(await carry()).toMatchObject({ carry: '0.09' });
      missedFlatReset = true;
      for (let i = 0; i < 4 && (await db.select().from(schema.copyLiveManualCloses))[0]?.state !== 'done'; i++) await pass(`${name}-flat-${i}`);
      expect((await db.select().from(schema.copyLiveManualCloses))[0]).toMatchObject({ state: 'done' });
      expect(shared.position).toBe('0');
      const owed = await carry();
      expect(owed).toMatchObject({ carry: '0.09' });
      return owed;
    }
    /** The re-open (N = 0.19) settled, then 60 % closed: f·N = 0.114 → 0.11. */
    async function partialCloseSizesFromN(name: string) {
      await new Promise(resolve => setTimeout(resolve, 5)); await pass(`${name}-reopen-settle`, false);
      expect(shared.position).toBe('0.19');
      await leaderTrades(1004, 'Close Long', '0.6', '1'); await pass(`${name}-partial`, false);
      expect(logs.filter(l => l.includes('failed'))).toEqual([]);
      expect(exchangeBodies.at(-1)).toMatchObject({ action: { orders: [{ b: false, s: '0.11', r: true }] } });
      expect(shared.position).toBe('0.08');
      await new Promise(resolve => setTimeout(resolve, 5)); await pass(`${name}-partial-settle`, false);
      expect(await dispatch(1004)).toMatchObject({ state: 'settled' });
      expect(await carry()).toMatchObject({ carry: '0.004' });
    }

    it('the open resets it (revision + 1, never an earlier time) and the partial close sends f·N, not carry + f·(N − carry)', async () => {
      const owed = await flatOwing('o10b');
      await leaderTrades(1003, 'Open Long', '1', '0'); await pass('o10b-reopen', false);
      const reset = await carry();
      expect(reset).toMatchObject({ carry: '0', revision: owed.revision + 1 });
      expect(reset.updatedAt.getTime()).toBeGreaterThanOrEqual(owed.updatedAt.getTime());
      // The open's sizing basis names the reset carry, as its settlement requires.
      const [latest] = await db.select().from(schema.copyLiveIntentProvenance).orderBy(desc(schema.copyLiveIntentProvenance.admittedAt)).limit(1);
      expect((latest!.sizingBasis as { basis: { carry: unknown } }).basis.carry).toEqual({ amount: '0', revision: owed.revision + 1 });
      await partialCloseSizesFromN('o10b');
    });

    // A leg of the coin this generation's manifest does not show (journaled on
    // another address): the SQL conditions of the reset are a check of their own.
    const other = `0x${'66'.repeat(20)}`, otherStream = `mainnet:0x${'77'.repeat(20)}`;
    async function otherLeg(state: string) {
      await db.insert(schema.copyLiveSourceStreams).values({ id: otherStream, network: 'mainnet', leaderAddress: `0x${'77'.repeat(20)}` });
      await db.insert(schema.copyLiveSourceFills).values({ id: `${otherStream}:900`, streamId: otherStream, network: 'mainnet', leaderAddress: `0x${'77'.repeat(20)}`, tid: '900',
        providerTime: new Date(Date.now() - 3000), receivedAt: new Date(Date.now() - 3000), coin: 'BTC', oid: '1900', tradeKey: 'oid:1900', px: '100', sz: '1', side: 'A', startPosition: '1',
        normalized: {}, raw: {}, sourceDigest: 'a'.repeat(64) });
      await db.insert(schema.copyLiveExecutions).values({ key: 'other-leg', network: 'testnet', accountAddress: other, signerAddress: `0x${'33'.repeat(20)}`, cloid: `0x${'9'.repeat(32)}`,
        nonce: Date.now(), userId: 1, strategyId: 9, state, updatedAt: new Date(Date.now() - 2000), record: { key: 'other-leg', state } });
      await db.insert(schema.copyLiveSignalLegs).values({ id: 'other-leg', mandateId: 'mandate', sourceFillId: `${otherStream}:900`, leg: 'close', tradeKey: 'oid:1900', sign: 1, size: '1',
        fraction: '0.5', executionKey: 'other-leg', state: 'prepared', createdAt: new Date(Date.now() - 2000), updatedAt: new Date(Date.now() - 2000) });
      await db.insert(schema.copyLiveIntentProvenance).values({ key: 'other-leg', legId: 'other-leg', mandateId: 'mandate', mandateRevision: 1, sourceDigest: 'a'.repeat(64),
        settingsDigest: 'b'.repeat(64), fingerprint: 'c'.repeat(64), plannerVersion: 1, intent: {}, sizingBasis: {}, admittedAt: new Date(Date.now() - 2000) });
    }
    async function otherReservation(state: 'held' | 'unknown') {
      await otherLeg('filled');
      await db.insert(schema.copyStrategies).values({ id: 10, userId: 1, mode: 'testnet', leaderAddress: `0x${'77'.repeat(20)}`, allocated: '0', cash: '0', status: 'active', activatedAt: new Date() });
      await db.insert(schema.copyExecutionAccounts).values({ id: 'other-account', userId: 1, strategyId: 10, network: 'testnet', state: 'ready', address: other, privyUserId: 'did:privy:risk-source',
        externalId: 'other-master', privyWalletId: 'other-master', ownerQuorumId: 'owner' });
      await db.insert(schema.copyLiveRiskReservations).values({ key: 'other-leg', accountId: 'other-account', userId: 1, strategyId: 10, network: 'testnet', accountAddress: other,
        cloid: `0x${'9'.repeat(32)}`, fingerprint: 'c'.repeat(64), walletId: 'agent', authorizationId: 'grant', strategyVersion: 2, policyVersion: 1, authorizationVersion: 4,
        coin: 'BTC', dex: '', asset: 0, notionalUsd: '10', marginUsd: '1', feeBufferUsd: '0.01', payload: { intent: {}, action: {} }, sourceDigest: 'a'.repeat(64), state,
        ...(state === 'unknown' ? { attemptedAt: new Date(Date.now() - 1900) } : {}), expiresAt: new Date(Date.now() + 60000), createdAt: new Date(Date.now() - 2000), updatedAt: new Date(Date.now() - 2000) });
    }
    it.each([
      ['a journal of it prepared', () => otherLeg('prepared')],
      ['a journal of it submitting', () => otherLeg('submitting')],
      ['a journal of it unknown', () => otherLeg('unknown')],
      ['a journal of it resting', () => otherLeg('resting')],
      ['a reservation of it held', () => otherReservation('held')],
      ['a reservation of it unknown', () => otherReservation('unknown')],
    ] as const)('while another leg of the coin is in flight (%s) nothing is reset or sent; once it ended the open resets and goes', async (_case, inFlight) => {
      const owed = await flatOwing('o10b-busy');
      await inFlight();
      const sent = exchangeBodies.length, journals = async () => (await db.select().from(schema.copyLiveExecutions).where(eq(schema.copyLiveExecutions.accountAddress, seed.f.identity.accountAddress))).length;
      const journaled = await journals();
      await leaderTrades(1003, 'Open Long', '1', '0'); await pass('o10b-busy-reopen', false);
      expect(exchangeBodies).toHaveLength(sent);
      expect(await carry()).toEqual(owed);
      expect(await dispatch(1003)).toMatchObject({ leg: 'open', state: 'pending', reason: 'live_preparation_generation_changed' });
      expect(await journals()).toBe(journaled);
      logs = [];
      // The other leg ended (its order settled).
      await db.update(schema.copyLiveExecutions).set({ state: 'cancelled' }).where(eq(schema.copyLiveExecutions.key, 'other-leg'));
      await db.update(schema.copyLiveRiskReservations).set({ state: 'released', releaseReason: 'verified_settlement', releaseEvidenceDigest: 'd'.repeat(64), attemptedAt: new Date(Date.now() - 1900) })
        .where(eq(schema.copyLiveRiskReservations.key, 'other-leg'));
      await pass('o10b-busy-reopen-again', false);
      expect(exchangeBodies).toHaveLength(sent + 1);
      expect(await carry()).toMatchObject({ carry: '0', revision: owed.revision + 1 });
      await partialCloseSizesFromN('o10b-busy');
    });
  });
  // Safety exits: a pause, reduce-only or copy trading switched off means no
  // new risk. The leader's add is refused, never sent (nor caught up after a
  // resume), and its close is still mirrored: a reduce-only IOC of what the
  // follower holds, never stranded by the control.
  it.each([
    ['the owner paused the copy', 'strategy_paused'],
    ['the platform paused new risk', 'platform_paused'],
    ['the owner\'s account paused new risk', 'user_paused'],
    ['the platform set reduce-only', 'platform_reduce_only'],
    ['copy trading is switched off', 'live_risk_platform_disabled'],
  ] as const)('%s: the leader\'s add is refused, its close is still mirrored reduce-only', async (_control, refusal) => {
    let e = engine(); await e.tick(); await leaderOpens(1001); await e.tick(); await new Promise(resolve => setTimeout(resolve, 5)); await e.tick();
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'settled' });
    expect(shared.position).toBe('0.19');
    if (refusal === 'strategy_paused') await new UnitOfWork(db).run(tx => new CopyLiveMandateRepository(db, testConfig()).barrier(tx, 1, 'mandate', 'paused', Date.now));
    if (refusal === 'platform_paused') await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, 'platform'));
    if (refusal === 'user_paused') await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, 'user'));
    if (refusal === 'platform_reduce_only') await db.update(schema.copyControls).set({ reduceOnly: true }).where(eq(schema.copyControls.scope, 'platform'));
    if (refusal === 'live_risk_platform_disabled') await db.update(schema.appSettings).set({ value: { copyTradingEnabled: false } }).where(eq(schema.appSettings.key, 'general'));
    // The next minute's testnet quota (production: a later pass).
    budget.onModuleDestroy(); budget = new RequestBudgeterService(config);
    e = engine('100', new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: `e2e-${refusal}`, ownerId: `e2e-${refusal}` }, raw));
    await leaderTrades(1002, 'Open Long', '1', '1');
    await leaderTrades(1003, 'Close Long', '2', '2');
    await e.tick();
    const rows = await db.select().from(schema.copyLiveDispatches);
    expect(rows.find(row => row.sourceFillId.endsWith(':1002'))).toMatchObject({ leg: 'open', state: 'refused', reason: refusal });
    expect(exchangeBodies).toHaveLength(2);
    expect(exchangeBodies[1]).toMatchObject({ action: { type: 'order', orders: [{ a: 0, b: false, s: '0.19', r: true, t: { limit: { tif: 'Ioc' } } }] } });
    expect(shared.position).toBe('0');
    expect(rows.find(row => row.sourceFillId.endsWith(':1003'))).toMatchObject({ leg: 'close', state: 'submitted' });
  });
  it('refuses excessive cross-network price deviation before signing RPC, nonce, journal or financial POST', async () => {
    const e = engine('120'); await e.tick(); await leaderOpens(); await e.tick();
    expect(exchangeBodies).toHaveLength(0);
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'refused', reason: 'live_source_price_deviation' });
    const privy = raw.mock.calls.filter(([url]) => String(url).includes('privy.io'));
    expect(privy).toHaveLength(1);
    expect(String(privy[0]![0])).toBe('https://api.privy.io/v1/wallets/agent');
    expect(privy[0]![1]?.method).toBe('GET');
    expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
    expect(await db.select().from(schema.copyLiveRiskReservations)).toHaveLength(0);
  });
});
