import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CopyControlService } from '../src/copy/copy-control.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveSystemStops } from '../src/copy/copy-live-stop-system.js';
import { CopyOrderPlanner } from '../src/copy/copy-planner.service.js';
import { CopyRiskPolicyService } from '../src/copy/copy-risk-policy.service.js';
import { CopyRepository } from '../src/copy/copy.repository.js';
import type { CopyMarketService } from '../src/copy/copy-market.service.js';
import { Dec } from '../src/common/decimal/dec.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { testConfig } from './config-test-utils.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// The admin's 全部平倉 (close_positions at platform or user scope) on a
// deployment with a running actual copy (the preparation fixture's testnet copy).
let db: TestDb, controls: CopyControlService, system: CopyLiveSystemStops;
const market = { midPrices: async () => ({ at: new Date(), px: new Map([['BTC', Dec.from(100)]]), missingDexes: new Set<string>() }) } as unknown as CopyMarketService;
const admin = { kind: 'service', permissions: ['execution.pause'] } as const;

beforeEach(async () => {
  db = getTestDb(); await preparationFixture(db);
  const repository = new CopyRepository(db), uow = new UnitOfWork(db);
  system = new CopyLiveSystemStops(db, uow, new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())), testConfig());
  system.now = () => now;
  controls = new CopyControlService(repository, uow, market, new CopyOrderPlanner(repository), new CopyRiskPolicyService(repository, uow, market, null as never), system);
});
afterAll(closeTestDb);

describe('admin close-all on actual copies', () => {
  it('stops every running actual copy (close, then return) through the stop executor, audited per copy', async () => {
    const result = await controls.apply({ scope: 'platform', command: 'close_positions', expectedRevision: 0, reason: 'kill switch drill' }, admin);
    expect(result.event.result).toEqual({ cancelledOrders: 0, closeOrders: 1, liveStops: 1 });
    const [stop] = await db.select().from(schema.copyLiveStopOperations);
    expect(stop).toMatchObject({ accountId: 'account', mandateId: 'mandate', state: 'requested', issue: null, trackingComplete: true });
    expect(stop!.idempotencyKey).toMatch(/^admin-close-all-r1-mandate-2$/);
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'stopping', pauseNewRisk: true, reduceOnly: true });
    const audits = await db.select().from(schema.adminAuditLogs).orderBy(schema.adminAuditLogs.id);
    expect(audits.map(a => [a.event, a.target])).toEqual([['copy.control', 'platform:0'], ['copy.control', 'account:account']]);
    expect(audits[1]!.afterJson).toMatchObject({ command: 'close_positions', reason: 'admin_close_all', stopId: stop!.id });
    // Asked again: the copy is already stopping; nothing new.
    await controls.apply({ scope: 'platform', command: 'close_positions', expectedRevision: 1, reason: 'again' }, admin);
    expect(await db.select().from(schema.copyLiveStopOperations)).toHaveLength(1);
  });

  it('a user-scoped close-all stops only that owner\'s copies, also for an owner an admin disabled; a stale revision stops none', async () => {
    await expect(controls.apply({ scope: 'user', userId: 1, command: 'close_positions', expectedRevision: 5, reason: 'stale screen' }, admin)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.copyLiveStopOperations)).toEqual([]);
    expect(await system.running({ userId: 2 })).toEqual([]);
    await db.update(schema.users).set({ disabledAt: new Date(now) });
    await controls.apply({ scope: 'user', userId: 1, command: 'close_positions', expectedRevision: 0, reason: 'disabled owner' }, admin);
    expect(await db.select().from(schema.copyLiveStopOperations)).toEqual([expect.objectContaining({ userId: 1, state: 'requested' })]);
  });

  it('pause (no close) leaves actual copies running', async () => {
    await controls.apply({ scope: 'platform', command: 'pause_new_risk', expectedRevision: 0, reason: 'pause only' }, admin);
    expect(await db.select().from(schema.copyLiveStopOperations)).toEqual([]);
  });
});
