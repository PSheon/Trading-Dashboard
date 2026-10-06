import { testConfig } from './config-test-utils.js';
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
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import { CopyLiveManualCloser, CopyLiveStopper } from '../src/copy/live-worker/copy-live-stopper.js';
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

// Only native network endpoints are doubles (Privy, Hyperliquid REST/WS).
// The engine, runtime, risk, journal, reservation, receipt ledger and
// settlement are the production classes on a real database.
const shared = vi.hoisted(() => ({ clock: 0, position: '0', withdrawable: '80' }));
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
        const sums = { accountValue: shared.withdrawable === '0' && size === '0' ? '0' : '100', totalNtlPos: notional, totalRawUsd: String((shared.withdrawable === '0' && size === '0' ? 0 : 100) - Number(notional)), totalMarginUsed: margin };
        const assetPositions = size === '0' ? [] : [{ type: 'oneWay', position: { coin: 'BTC', szi: size, entryPx: '100', positionValue: notional, unrealizedPnl: '0',
          marginUsed: margin, maxLeverage: 20, leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }];
        const state = { marginSummary: sums, crossMarginSummary: sums, crossMaintenanceMarginUsed: '0', withdrawable: shared.withdrawable, time: Date.now(), assetPositions };
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
let raw: ReturnType<typeof vi.fn<typeof fetch>>, exchangeBodies: unknown[];
let placedOrders: { oid: number; cloid: string; p: string; s: string; side: string; r: boolean; at: number }[] = [];
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
  shared.clock = Date.now(); shared.position = '0'; shared.withdrawable = '80'; logs = []; exchangeBodies = []; placedOrders = [];
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

const meta = { collateralToken: 7, universe: [{ name: 'BTC', szDecimals: 2, maxLeverage: 20 }] };
async function providers(endpoint: string, body: Record<string, unknown> | undefined): Promise<Response> {
  if (endpoint === 'https://api.privy.io/v1/wallets/agent') return Response.json({ id: 'agent', chain_type: 'ethereum', address: agent.address, owner_id: 'owner', archived_at: null });
  if (endpoint === 'https://api.privy.io/v1/wallets/agent/rpc') {
    const typed = (body as { params: { typed_data: Record<string, unknown> & { primary_type: string } } }).params.typed_data;
    return Response.json({ method: 'eth_signTypedData_v4', data: { encoding: 'hex', signature: await agent.signTypedData({ ...typed, primaryType: typed.primary_type } as unknown as TypedDataDefinition) } });
  }
  if (endpoint === 'https://api.hyperliquid-testnet.xyz/exchange') {
    exchangeBodies.push(body); const order = (body as { action: { orders: { c: string; p: string; s: string; b: boolean; r: boolean }[] } }).action.orders[0]!;
    const placed = { oid: 77 + placedOrders.length, cloid: order.c, p: order.p, s: order.s, side: order.b ? 'B' : 'A', r: order.r, at: Date.now() };
    placedOrders.push(placed);
    shared.position = String(placedOrders.reduce((sum, o) => sum + (o.side === 'B' ? 1 : -1) * Number(o.s), 0));
    return Response.json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: placed.oid, totalSz: order.s, avgPx: '100' } }] } } });
  }
  expect(endpoint).toBe('https://api.hyperliquid-testnet.xyz/info');
  const user = body!.user, status = placedOrders.find(o => o.cloid === body!.oid);
  const values: Record<string, unknown> = { userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false,
    spotClearinghouseState: { portfolioMarginEnabled: false, balances: [] }, perpDexs: [null], spotMeta: { tokens: [{ index: 7, name: 'USDC', isCanonical: true }] },
    meta, allPerpMetas: [meta], metaAndAssetCtxs: [meta, [{ midPx: '100', markPx: '100' }]], allMids: { BTC: '100' },
    activeAssetData: { user, coin: 'BTC', leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['1', '1'], availableToTrade: ['100', '100'], markPx: '100' },
    userFees: { userAddRate: '-0.0001', userCrossRate: '0.0005', activeReferralDiscount: '0', trial: null },
    extraAgents: [{ address: agent.address, name: 'dedicated', validUntil: Date.now() + 60000 }],
    orderStatus: status ? { status: 'order', order: { status: 'filled', statusTimestamp: status.at + 2, order: { coin: 'BTC', oid: status.oid, cloid: status.cloid, side: status.side, reduceOnly: status.r,
      tif: 'Ioc', origSz: status.s, sz: '0', limitPx: status.p, timestamp: status.at, isTrigger: false, isPositionTpsl: false, children: [] } } } : { status: 'unknownOid' },
    userFillsByTime: placedOrders.map((o, i) => ({ coin: 'BTC', px: '100', sz: o.s, side: o.side, time: o.at + 1, startPosition: '0', dir: 'Open Long', closedPnl: '0',
      hash: `0x${String(34 + i).repeat(32)}`, oid: o.oid, crossed: true, fee: '0.01', tid: 501 + i, feeToken: 'USDC' })), userFunding: [] };
  if (!(String(body!.type) in values)) throw Error(`Unsupported offline INFO ${String(body!.type)}`);
  return Response.json(values[String(body!.type)]);
}
function engine(midPrice = '100', egress = global, withStopper = false) {
  // Settlement right after the order (scan 240 + status + account ~630): an
  // order and its settlement exceed one minute's 1200 testnet weight, so in
  // production settlement waits for a later pass; here it gets its own room.
  const settleGlobal = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: 'e2e-settle-egress', ownerId: 'e2e-settle' }, raw);
  const settleBudget = new RequestBudgeterService(new AppConfig({ ...config.value, hyperliquid: { ...config.value.hyperliquid, budgetPerMin: 200, burst: 1000 } }));
  const reference = { network: 'mainnet' as const, read: vi.fn(async () => ({ midPrice, midObservedAt: Date.now(), leaderEquity: null, leaderEquityObservedAt: null })) };
  const options = { slippageBps: '30', extraRiskBufferBps: '5', restingOrderBuilderFeeCapTenthsBps: 100, maxSourceDeviationBps: '500' };
  const stops = new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), testConfig()), closer = new ReduceOnlyCloser('testnet', pool, db, new UnitOfWork(db), config, egress, budget, 100, clock);
  const stopOnly = new CopyLiveStopper({ repository: stops, canceller: null, swept: async () => false, closer, log: message => logs.push(message) }, clock);
  const manual = new CopyLiveManualCloser(stops, closer, new CopyFollowerReconciler(new CopyFollowerScanRepository(db, testConfig()), new CopyFollowerLedger(db, new UnitOfWork(db)),
    new HyperliquidFollowerReceiptReader('testnet', weight => budget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) }), egress.fetchInfo, clock)), message => logs.push(message));
  const stopper = withStopper ? { tick: async () => { await stopOnly.tick(); await manual.tick(); } } : undefined;
  return new CopyLiveEngine({ stopper,
    network: 'testnet', repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db, clock), testnetSource: { read: vi.fn() } as never,
    runtime: hooks => new LiveExecutionRuntime('testnet', pool, config, egress, budget, options, clock, { ...hooks, reference }),
    settler: new CopyLiveSettler('testnet', pool, settleGlobal, settleBudget, new CopyFollowerReconciler(new CopyFollowerScanRepository(db, testConfig()), new CopyFollowerLedger(db, new UnitOfWork(db)),
      new HyperliquidFollowerReceiptReader('testnet', weight => settleBudget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) }), settleGlobal.fetchInfo, clock)), clock), log: message => logs.push(message),
  }, { testnetSourceIntervalMs: 60_000, sourceLagMs: 0, passBudgetMs: 60_000 }, clock);
}
async function leaderOpens(tid = 1001) {
  await new Promise(resolve => setTimeout(resolve, 5));
  const time = Date.now() - 2, rawFill = { coin: 'BTC', px: '100', sz: '1', side: 'B', time, startPosition: '0', dir: 'Open Long', closedPnl: '0',
    hash: `0x${'12'.repeat(32)}`, oid: 1000 + tid, crossed: true, fee: '0.01', tid, feeToken: 'USDC' };
  await db.insert(schema.fills).values({ address: leader, tid: BigInt(tid), coin: 'BTC', side: 'B', dir: 'Open Long', px: '100', sz: '1', fee: '0.01', hash: rawFill.hash, ts: new Date(time), raw: rawFill });
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
  it('refuses the open when the testnet mid strays from mainnet beyond the threshold; nothing is signed or sent', async () => {
    const e = engine('120'); await e.tick(); await leaderOpens(); await e.tick();
    expect(exchangeBodies).toHaveLength(0);
    expect((await db.select().from(schema.copyLiveDispatches))[0]).toMatchObject({ state: 'refused', reason: 'live_source_price_deviation' });
    expect(raw.mock.calls.some(([url]) => String(url).includes('privy.io'))).toBe(false);
  });
});
