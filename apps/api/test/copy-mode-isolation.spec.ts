import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { copyEquitySnapshots, copyEvents, copyLedger, copyOrders, copyPaperFills, copyPositions,
  copyReservations, copySignalLegs, copySignalOutbox, copyStrategies, copyStrategyVersions, paperAccounts } from '@trading-dashboard/shared/database';
import { CopyRepository } from '../src/copy/copy.repository.js';
import { CopyStrategyService } from '../src/copy/copy-strategy.service.js';
import { CopyController } from '../src/copy/copy.controller.js';
import { CopyRiskPolicyService } from '../src/copy/copy-risk-policy.service.js';
import { CopyOrderPlanner } from '../src/copy/copy-planner.service.js';
import { CopyControlService } from '../src/copy/copy-control.service.js';
import { CopyExecutionService } from '../src/copy/copy-execution.service.js';
import { CopyPerformanceService } from '../src/copy/copy-performance.service.js';
import { CopyAdminReadService } from '../src/copy/copy-admin-read.service.js';
import { CopySignalService } from '../src/copy/copy-signal.service.js';
import { CopyAdoptionRepairService } from '../src/copy/copy-adoption-repair.service.js';
import { enqueueCopySignals } from '../src/copy/copy-outbox.js';
import { toCopyStrategy } from '../src/copy/copy.mappers.js';
import { AssetMap, type CopyMarketService } from '../src/copy/copy-market.service.js';
import { FillSyncRepository } from '../src/watcher/fill-sync.repository.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { Dec } from '../src/common/decimal/dec.js';
import { testConfig } from './config-test-utils.js';
import { getTestDb, closeTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';

let db: TestDb, repository: CopyRepository, uow: UnitOfWork, uid: number, did: string, paperId: number, liveId: number;
let service: CopyStrategyService, execution: CopyExecutionService, controls: CopyControlService, performance: CopyPerformanceService;
let planner: CopyOrderPlanner, policies: CopyRiskPolicyService, admin: CopyAdminReadService;
const paperLeader = `0x${'11'.repeat(20)}`, liveLeader = `0x${'22'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'fixed' as const, perTradeUsd: 100,
  maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const market = {
  midPrices: async () => ({ at: new Date(), px: new Map([['BTC', Dec.from(100)]]), missingDexes: new Set<string>() }),
  assetInfo: async () => new AssetMap([['BTC', { szDecimals: 3, maxLeverage: 40, markPx: Dec.from(100), funding: Dec.from('0.01') }]]),
  leaderEquity: async () => ({ state: 'known', value: Dec.from(1000) }),
  leaderSnapshot: async () => ({ assetPositions: [], at: new Date() }),
} as unknown as CopyMarketService;
const site = { get: async () => ({ copyTradingEnabled: true, builderFeeTenthsBps: 0 }) };

beforeAll(() => { db = getTestDb(); repository = new CopyRepository(db); uow = new UnitOfWork(db); });
beforeEach(async () => {
  await truncateAll(db);
  const owner = await insertUser(db); uid = owner.id; did = owner.privyUserId;
  paperId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: paperLeader, mode: 'paper', allocated: '1000', cash: '1000', activatedAt: new Date(0) }).returning())[0].id;
  // Root migration0043 supplies this mode. These are new rows, never converted paper profiles.
  const inserted = await db.execute<{ id: number }>(sql`insert into copy_strategies(user_id,leader_address,mode,status,allocated,cash,activated_at)
    values(${uid},${liveLeader},'testnet','paused',0,0,to_timestamp(0)) returning id`);
  liveId = inserted.rows[0].id;
  for (const strategyId of [paperId, liveId]) await db.insert(copyStrategyVersions).values({ strategyId, version: 1, settings, createdByUserId: uid });
  policies = new CopyRiskPolicyService(repository, uow, market, null as never);
  planner = new CopyOrderPlanner(repository);
  controls = new CopyControlService(repository, uow, market, planner, policies);
  service = new CopyStrategyService(testConfig(), repository, uow, market, planner, policies, controls, site as never);
  execution = new CopyExecutionService(repository, uow, market, policies, site as never);
  performance = new CopyPerformanceService(repository, uow, market);
  admin = new CopyAdminReadService(testConfig(), repository, market, policies);
});
afterAll(closeTestDb);
const strategy = async (id: number) => (await db.select().from(copyStrategies).where(eq(copyStrategies.id, id)))[0];
const position = (strategyId: number) => db.insert(copyPositions).values({ strategyId, coin: 'BTC', size: '1', entryPx: '100', fundingThrough: new Date(Date.now() - 2 * 3600000) });
async function order(strategyId: number, status: 'risk_approved' | 'submitting' | 'rejected' = 'risk_approved', leg: 'open' | 'adopt' = 'open') {
  return (await db.insert(copyOrders).values({ strategyId, userId: uid, leaderAddress: strategyId === liveId ? liveLeader : paperLeader,
    cloid: `0x${String(strategyId).padStart(32, '0')}`, strategyVersion: 1, riskPolicyVersion: 0,
    coin: 'BTC', leg, side: 'B', size: '1', reduceOnly: false, signalPx: '100', signalTime: new Date(), signalTids: [],
    controlRevisions: { platform: 0, user: 0, strategy: 0 }, status,
    reason: status === 'rejected' ? 'no_price' : null, updatedAt: new Date(Date.now() - 60000) }).returning())[0];
}
async function unchangedLive(before: Awaited<ReturnType<typeof strategy>>) {
  expect(await strategy(liveId)).toEqual(before);
  expect(await db.select().from(copyLedger).where(eq(copyLedger.strategyId, liveId))).toEqual([]);
  expect(await db.select().from(copyPaperFills).where(eq(copyPaperFills.strategyId, liveId))).toEqual([]);
}

describe('paper strategy and read model isolation', () => {
  it('excludes testnet from paper owner/admin/worker strategy selectors', async () => {
    expect((await repository.strategiesOfUser(uid)).map(r => r.strategy.id)).toEqual([paperId]);
    expect((await repository.allStrategies({ limit: 10 })).map(r => r.strategy.id)).toEqual([paperId]);
    expect((await repository.liveStrategies()).map(r => r.strategy.id)).toEqual([paperId]);
    expect((await repository.liveStrategiesOf([paperLeader, liveLeader])).map(r => r.id)).toEqual([paperId]);
    expect((await repository.runtime.activeStrategies()).map(r => r.id)).toEqual([paperId]);
    expect(await uow.run(tx => repository.liveStrategyIdsOfUser(tx, uid))).toEqual([{ id: paperId, userId: uid }]);
  });
  it('does not read a testnet id through the paper repository or strategy mapper', async () => {
    expect(await repository.strategyWithSettings(liveId)).toBeUndefined();
    expect(await uow.run(tx => repository.lockStrategy(tx, liveId))).toBeUndefined();
    expect(() => toCopyStrategy(awaitedLive!, settings, [], null)).toThrow();
  });
  let awaitedLive: Awaited<ReturnType<typeof strategy>>;
  beforeEach(async () => { awaitedLive = await strategy(liveId); });
  it('pins paper accounting mode even when this deployment disables execution', async () => {
    const previous = process.env.COPY_TRADING_MODE;
    process.env.COPY_TRADING_MODE = 'disabled';
    try {
      const overview = await service.overview(uid);
      expect(overview.mode).toBe('paper');
      expect(overview.strategies.map(s => s.id)).toEqual([paperId]);
      expect(overview.paper).toMatchObject({ balance: 10000, allocated: 1000, totalValue: 11000 });
      expect((await admin.overview()).mode).toBe('disabled');
    } finally { if (previous === undefined) delete process.env.COPY_TRADING_MODE; else process.env.COPY_TRADING_MODE = previous; }
  });
  it.each(['patch', 'addFunds', 'withdrawFunds', 'pause', 'stop', 'orders', 'fills', 'ledger', 'performance', 'admin'] as const)(
    'rejects testnet id on paper %s path without altering it', async path => {
      const before = await strategy(liveId);
      const call = path === 'patch' ? service.patch(uid, liveId, { maxLeverage: 3 }) :
        path === 'addFunds' ? service.addFunds(uid, liveId, { amountUsd: 100 }) :
        path === 'withdrawFunds' ? service.withdrawFunds(uid, liveId, { amountUsd: 100 }) :
        path === 'pause' || path === 'stop' ? service.command(uid, liveId, path) :
        path === 'orders' ? service.orders(uid, liveId) : path === 'fills' ? service.fills(uid, liveId) :
        path === 'ledger' ? service.ledger(uid, liveId) : path === 'performance' ? performance.history(uid, liveId, { window: '1d' }) : admin.strategy(liveId);
      await expect(call).rejects.toMatchObject({ status: 404 });
      await unchangedLive(before);
      expect(await db.select().from(paperAccounts)).toEqual([]);
    });
  it('captures performance only for paper without relabeling testnet zero cash as equity', async () => {
    await performance.capture();
    expect((await db.select().from(copyEquitySnapshots)).map(r => r.strategyId)).toEqual([paperId]);
  });
  it('creates a separate paper copy beside the same leader testnet row without converting it', async () => {
    const before = await strategy(liveId);
    const created = await service.create(uid, { leader: liveLeader, allocationUsd: 100, copyStartMode: 'delta', sizingMode: 'fixed', perTradeUsd: 100 });
    expect(created).toMatchObject({ mode: 'paper', cash: 100, allocated: 100, leaderAddress: liveLeader });
    expect(created.id).not.toBe(liveId);
    await unchangedLive(before);
    expect((await repository.strategiesOfUser(uid)).map(r => r.strategy.id).sort()).toEqual([paperId, created.id].sort());
  });
  it('actual authenticated paper HTTP routes return404 for testnet without changing funds, settings or status', async () => {
    const before = await strategy(liveId);
    const { app } = await createAuthedApp({ db, privy: stubPrivy({ 'mode-owner-token': { privyUserId: did } }), controllers: [CopyController],
      providers: [{ provide: CopyStrategyService, useValue: service }, { provide: CopyPerformanceService, useValue: performance }] });
    try {
      const http = app.getHttpServer(), base = `/me/copy/strategies/${liveId}`, token = 'Bearer mode-owner-token';
      await request(http).get(`${base}/orders`).expect(401);
      await request(http).patch(base).set('Authorization', token).send({ maxLeverage: 3 }).expect(404);
      await request(http).post(`${base}/funds`).set('Authorization', token).send({ amountUsd: 100 }).expect(404);
      await request(http).post(`${base}/withdraw-funds`).set('Authorization', token).send({ amountUsd: 100 }).expect(404);
      await request(http).post(`${base}/commands`).set('Authorization', token).send({ command: 'stop' }).expect(404);
      for (const route of ['orders', 'fills', 'ledger', 'performance']) await request(http).get(`${base}/${route}`).set('Authorization', token).expect(404);
      await unchangedLive(before);
      expect(await db.select().from(paperAccounts)).toEqual([]);
    } finally { await app.close(); }
  });
});

describe('paper passes cannot consume testnet strategies or their accidental paper children', () => {
  it('ignores testnet positions in paper exposure and funding inputs', async () => {
    await position(paperId); await position(liveId);
    expect((await repository.positionsOf([paperId, liveId])).map(p => p.strategyId)).toEqual([paperId]);
    expect((await repository.openPositionsOfLive()).map(r => r.position.strategyId)).toEqual([paperId]);
    expect((await repository.positionsDueFunding(new Date())).map(r => r.strategyId)).toEqual([paperId]);
    expect((await admin.exposure()).items[0].strategies).toBe(1);
  });
  it('does not accrue simulated funding or liquidate actual testnet strategy', async () => {
    await position(paperId); await position(liveId);
    await db.update(copyStrategies).set({ cash: '0' }).where(eq(copyStrategies.id, paperId));
    const before = await strategy(liveId), livePosition = (await db.select().from(copyPositions).where(eq(copyPositions.strategyId, liveId)))[0];
    expect(await execution.accrueFunding()).toBe(1);
    expect(await execution.liquidate()).toBe(1);
    await unchangedLive(before);
    expect((await db.select().from(copyPositions).where(eq(copyPositions.strategyId, liveId)))[0]).toEqual(livePosition);
  });
  it('never fake-settles a testnet stopping strategy from empty paper positions', async () => {
    await db.update(copyStrategies).set({ status: 'stopping' }).where(eq(copyStrategies.id, liveId));
    const before = await strategy(liveId);
    expect(await execution.settleStopping()).toBe(0);
    await unchangedLive(before);
    expect(await db.select().from(paperAccounts)).toEqual([]);
    expect(await db.select().from(copyEquitySnapshots)).toEqual([]);
  });
  it('worker approval/recovery and direct simulated submit/fill ignore testnet child orders', async () => {
    const paper = await order(paperId), live = await order(liveId);
    expect((await repository.approvedOrders(10)).map(r => r.id)).toEqual([paper.id]);
    const before = await strategy(liveId);
    expect(await execution.submit(live.id)).toBe('skipped');
    await db.update(copyOrders).set({ status: 'submitting' }).where(eq(copyOrders.id, live.id));
    expect(await repository.staleSubmitting(new Date(), 10)).toEqual([]);
    expect(await execution.fill(live.id, { mids: await market.midPrices(['BTC']), assets: await market.assetInfo(['BTC']),
      slippageBps: 0, takerFeeBps: 0, builderFeeTenthsBps: 0 })).toBe(false);
    expect((await db.select().from(copyOrders).where(eq(copyOrders.id, live.id)))[0].status).toBe('submitting');
    await unchangedLive(before);
  });
  it('global controls retain their barrier but cancel/close only paper orders', async () => {
    const paper = await order(paperId), live = await order(liveId);
    await db.insert(copyReservations).values({ orderId: live.id, strategyId: liveId, userId: uid, coin: 'BTC', notional: '100', margin: '20' });
    await position(paperId); await position(liveId);
    const before = await strategy(liveId);
    const result = await controls.apply({ scope: 'platform', command: 'close_positions', expectedRevision: 0, reason: 'mode isolation' },
      { kind: 'service', permissions: ['execution.pause'] });
    expect(result.state.pauseNewRisk).toBe(true);
    expect(result.event.result).toEqual({ cancelledOrders: 1, closeOrders: 1 });
    expect((await db.select().from(copyOrders).where(eq(copyOrders.id, paper.id)))[0].status).toBe('cancelled');
    expect((await db.select().from(copyOrders).where(eq(copyOrders.id, live.id)))[0].status).toBe('risk_approved');
    expect((await db.select().from(copyReservations))[0].status).toBe('held');
    await unchangedLive(before);
  });
  it('direct owner paper stop refuses testnet without changing status or issuing a close', async () => {
    const before = await strategy(liveId);
    await expect(controls.strategyCommand(uid, liveId, 'stop')).rejects.toMatchObject({ status: 404 });
    await unchangedLive(before);
    expect(await db.select().from(copyOrders)).toEqual([]);
  });
  it('planner refuses a testnet reduction before writing a simulated order', async () => {
    await expect(uow.run(tx => planner.place(tx, { strategy: awaitedStrategy, settings, policy: { version: 0, invalid: false, limits: {} } as never,
      controls: { platform: undefined, user: undefined }, mids: null, assets: null, coin: 'BTC', leg: 'close', side: 'A', size: Dec.from(1), signalPx: Dec.from(100),
      signalTime: new Date(), signalTids: [], dedupeKey: 'actual-strategy-must-not-enter-paper-planner' }))).rejects.toThrow();
    expect(await db.select().from(copyOrders)).toEqual([]);
  });
  let awaitedStrategy: Awaited<ReturnType<typeof strategy>>;
  beforeEach(async () => { awaitedStrategy = await strategy(liveId); });
  it('generic fill watcher and paper signal cursor ignore testnet-only leaders', async () => {
    expect(await new FillSyncRepository(db).isCopied(liveLeader)).toBe(false);
    expect(await new FillSyncRepository(db).isCopied(paperLeader)).toBe(true);
    expect(await uow.run(tx => enqueueCopySignals(tx, liveLeader, [{ tid: 1n, ts: new Date() }]))).toBe(0);
    expect(await db.select().from(copySignalOutbox)).toEqual([]);
  });
  it('paper signal/adoption consumers do not create legs or orders for testnet', async () => {
    await db.insert(copySignalOutbox).values({ address: liveLeader, tid: 1n, fillTime: new Date() });
    await db.execute(sql`insert into fills(chain,address,tid,coin,side,dir,px,sz,fee,ts,raw)
      values('hyperliquid',${liveLeader},1,'BTC','B','Open Long',100,1,0,now(),
        ${JSON.stringify({ tid: 1, oid: 1, coin: 'BTC', side: 'B', px: '100', sz: '1', startPosition: '0', time: Date.now() })}::jsonb)`);
    const signals = new CopySignalService(repository, uow, market, planner, policies);
    await signals.drain();
    expect(await db.select().from(copySignalLegs)).toEqual([]);
    expect(await db.select().from(copyOrders)).toEqual([]);
    await db.update(copyStrategies).set({ status: 'active' }).where(eq(copyStrategies.id, liveId));
    await order(liveId, 'rejected', 'adopt');
    expect(await repository.rejectedAdoptions(['no_price'])).toEqual([]);
    expect(await new CopyAdoptionRepairService(repository, uow, market, planner, policies).repair()).toEqual([]);
  });
  it('paper strategy money helper cannot increase testnet cash even when called directly', async () => {
    const before = await strategy(liveId);
    await uow.run(tx => repository.addToStrategy(tx, liveId, { cash: '100', allocated: '100' }));
    await unchangedLive(before);
  });
  it('excludes accidental testnet child orders from stuck and pending risk inputs', async () => {
    const live = await order(liveId);
    await db.update(copyOrders).set({ attempts: 5, tradeKey: 'oid:123' }).where(eq(copyOrders.id, live.id));
    expect(await repository.stuckOrders(3)).toEqual([]);
    expect(await uow.run(tx => repository.pendingSizes(tx, liveId))).toEqual(new Map());
    expect(await uow.run(tx => repository.ordersLastMinute(tx, liveId))).toBe(0);
    expect(await uow.run(tx => repository.tradeAlreadyOrdered(tx, liveId, 'oid:123'))).toBe(false);
    expect(await uow.run(tx => repository.openOrderCount(tx, liveId))).toBe(0);
    await db.update(copyOrders).set({ leg: 'stop_close', reduceOnly: true, side: 'A' }).where(eq(copyOrders.id, live.id));
    expect(await uow.run(tx => repository.pendingReduceSizes(tx, [liveId]))).toEqual(new Map());
    expect(await uow.run(tx => repository.pendingStopCloses(tx, [liveId]))).toEqual(new Set());
  });
  it('a paper worker failure marker cannot overwrite a testnet child receipt status', async () => {
    const live = await order(liveId);
    expect(await repository.recordOrderFailure(live.id, 'simulated worker failure')).toBe(0);
    expect((await db.select().from(copyOrders).where(eq(copyOrders.id, live.id)))[0]).toMatchObject({ attempts: 0, lastError: null });
  });
  it('does not expose testnet settings history or position locks through the paper DAL', async () => {
    await position(liveId);
    expect(await repository.versionsOf(liveId)).toEqual([]);
    await expect(uow.run(tx => repository.settingsOf(tx, liveId, 1))).rejects.toThrow();
    expect(await uow.run(tx => repository.lockPosition(tx, liveId, 'BTC'))).toBeUndefined();
  });
  it('activation catchup cannot enqueue generic historical fills for a testnet-only leader', async () => {
    await db.execute(sql`insert into fills(chain,address,tid,coin,side,dir,px,sz,fee,ts,raw)
      values('hyperliquid',${liveLeader},1,'BTC','B','Open Long',100,1,0,now(),'{}'::jsonb)`);
    expect(await uow.run(tx => repository.catchUp(tx, liveLeader, new Date(0)))).toBe(0);
    expect(await db.select().from(copySignalOutbox)).toEqual([]);
  });
  it('paper reservation settlement and order update leave testnet children untouched', async () => {
    const live = await order(liveId);
    await db.insert(copyReservations).values({ orderId: live.id, strategyId: liveId, userId: uid, coin: 'BTC', notional: '100', margin: '20' });
    await uow.run(async tx => {
      await repository.updateOrder(tx, live.id, { status: 'cancelled', reason: 'paper cancellation' });
      await repository.refreshHeldReservation(tx, live.id, { notional: '200', margin: '40' });
      await repository.settleReservation(tx, live.id, 'released');
    });
    expect((await db.select().from(copyOrders))[0]).toMatchObject({ status: 'risk_approved', reason: null });
    expect((await db.select().from(copyReservations))[0]).toMatchObject({ status: 'held', notional: '100', margin: '20' });
  });
  it('paper position mutation helpers leave testnet children untouched', async () => {
    await position(liveId);
    const before = (await db.select().from(copyPositions))[0];
    await uow.run(async tx => {
      await repository.setReduceCarry(tx, liveId, 'BTC', '0.5');
      await repository.accruePositionFunding(tx, liveId, 'BTC', '1', new Date());
      await repository.savePosition(tx, liveId, 'BTC', { size: '2', entryPx: '200', realizedPnl: '1', opened: false });
    });
    expect((await db.select().from(copyPositions))[0]).toEqual(before);
  });
  it('paper events feed excludes testnet strategy events without suppressing shared owner events', async () => {
    await uow.run(async tx => {
      await repository.runtime.appendEvent(tx, uid, null, 'owner_event', {});
      await repository.runtime.appendEvent(tx, uid, paperId, 'paper_event', { mode: 'paper' });
      // Seed an old/stray event directly; the paper DAL now rejects creating it.
      await tx.insert(copyEvents).values({ userId: uid, strategyId: liveId, type: 'actual_event', payload: { mode: 'testnet' } });
    });
    expect((await performance.events(uid, { after: '0' })).items.map(e => e.type)).toEqual(['owner_event', 'paper_event']);
  });
});
