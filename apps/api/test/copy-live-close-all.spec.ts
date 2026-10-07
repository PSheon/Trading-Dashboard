import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { CopyControlService } from '../src/copy/copy-control.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CLOSE_ALL_RESUME_AFTER_MS, CopyLiveSystemStops } from '../src/copy/copy-live-stop-system.js';
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
// deployment that executes actual copies (the preparation fixture's running
// testnet copy).
let db: TestDb, controls: CopyControlService, system: CopyLiveSystemStops, repository: CopyRepository, uow: UnitOfWork;
const market = { midPrices: async () => ({ at: new Date(), px: new Map([['BTC', Dec.from(100)]]), missingDexes: new Set<string>() }) } as unknown as CopyMarketService;
const admin = { kind: 'service', permissions: ['execution.pause'] } as const;
/** testConfig with actual execution on (COPY_TRADING_MODE testnet). */
const liveConfig = (): AppConfig => { const base = testConfig(); return { get value() { return { ...base.value, copy: { ...base.value.copy, live: { network: 'testnet' } } }; } } as unknown as AppConfig; };
const service = (stops: CopyLiveSystemStops | undefined) => new CopyControlService(repository, uow, market, new CopyOrderPlanner(repository), new CopyRiskPolicyService(repository, uow, market, null as never), stops as CopyLiveSystemStops);
const events = () => db.select().from(schema.copyControlEvents).orderBy(schema.copyControlEvents.id);

beforeEach(async () => {
  db = getTestDb(); await preparationFixture(db);
  repository = new CopyRepository(db); uow = new UnitOfWork(db);
  system = new CopyLiveSystemStops(db, uow, new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, liveConfig())), liveConfig());
  system.now = () => now;
  controls = service(system);
});
afterAll(closeTestDb);

/** A second copy of user 1 on its own account: mid-setup (no activated generation). */
async function midSetupCopy(id: number) {
  await db.insert(schema.copyStrategies).values({ id, userId: 1, mode: 'testnet', leaderAddress: `0x5${id.toString(16).padStart(39, '0')}`, allocated: '0', cash: '0', status: 'active', activatedAt: new Date(now) });
  await db.insert(schema.copyExecutionAccounts).values({ id: `account-${id}`, userId: 1, strategyId: id, network: 'testnet', state: 'ready', address: `0x6${id.toString(16).padStart(39, '0')}`,
    privyUserId: 'did:privy:risk-source', externalId: `external-${id}`, privyWalletId: `master-${id}`, ownerQuorumId: 'owner' });
}

describe('admin close-all on actual copies', () => {
  it('stops every running actual copy (close, then return) through the stop executor, audited per copy and with its outcome on the event', async () => {
    const result = await controls.apply({ scope: 'platform', command: 'close_positions', expectedRevision: 0, reason: 'kill switch drill' }, admin);
    expect(result.event.result).toEqual({ cancelledOrders: 0, closeOrders: 1, liveCloseAll: 'done', liveStops: 1, liveStopping: 0, liveUnhandled: [], complete: true });
    const [stop] = await db.select().from(schema.copyLiveStopOperations);
    expect(stop).toMatchObject({ accountId: 'account', mandateId: 'mandate', state: 'requested', issue: null, trackingComplete: true });
    expect(stop!.idempotencyKey).toBe('admin-close-all-r1-mandate-2');
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'stopping', pauseNewRisk: true, reduceOnly: true });
    expect((await events())[0]!.result).toMatchObject({ liveCloseAll: 'done', liveStops: 1, complete: true });
    const audits = await db.select().from(schema.adminAuditLogs).orderBy(schema.adminAuditLogs.id);
    expect(audits.map(a => [a.event, a.target])).toEqual([['copy.control', 'platform:0'], ['copy.control', 'account:account'], ['copy.control', 'platform:0']]);
    expect(audits[1]!.afterJson).toMatchObject({ command: 'close_positions', reason: 'admin_close_all', stopId: stop!.id });
    expect(audits[2]!.afterJson).toMatchObject({ liveStops: 1, complete: true });
    // Asked again: the copy is already stopping (counted, not restarted).
    const again = await controls.apply({ scope: 'platform', command: 'close_positions', expectedRevision: 1, reason: 'again' }, admin);
    expect(again.event.result).toMatchObject({ liveStops: 0, liveStopping: 1, complete: true });
    expect(await db.select().from(schema.copyLiveStopOperations)).toHaveLength(1);
  });

  it('never skips a copy silently: a blocked stop, a funded copy still in setup and a refused stop are reported, and the answer is not a success', async () => {
    await midSetupCopy(31);
    const failure = await controls.apply({ scope: 'platform', command: 'close_positions', expectedRevision: 0, reason: 'kill switch' }, admin).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 409, response: { code: 'close_all_incomplete', unhandled: [{ accountId: 'account-31', code: 'no_activated_generation' }] } });
    // The running copy still stopped; the event and the audit say what was left.
    expect(await db.select({ accountId: schema.copyLiveStopOperations.accountId }).from(schema.copyLiveStopOperations)).toEqual([{ accountId: 'account' }]);
    expect((await events())[0]!.result).toMatchObject({ liveStops: 1, complete: false, liveUnhandled: [{ accountId: 'account-31', code: 'no_activated_generation' }] });
    // A blocked stop is never worked: reported, not counted as stopping.
    await db.update(schema.copyLiveStopOperations).set({ state: 'blocked', issue: 'tracked_execution_unproven', trackingComplete: false });
    await expect(controls.apply({ scope: 'platform', command: 'close_positions', expectedRevision: 1, reason: 'again' }, admin))
      .rejects.toMatchObject({ response: { unhandled: expect.arrayContaining([{ accountId: 'account', code: 'stop_blocked' }]) } });
  });

  it('a stop the copy\'s records refuse is reported with its reason', async () => {
    await db.update(schema.users).set({ embeddedWalletAddress: `0x${'77'.repeat(20)}` });
    await expect(controls.apply({ scope: 'platform', command: 'close_positions', expectedRevision: 0, reason: 'kill switch' }, admin))
      .rejects.toMatchObject({ response: { code: 'close_all_incomplete', unhandled: [{ accountId: 'account', code: 'live_stop_binding_changed' }] } });
  });

  it('covers every account past one page (no limit leaves copies out)', async () => {
    for (let id = 100; id < 100 + 501; id++) await midSetupCopy(id);
    const targets = await system.targets();
    expect(targets.copies.map(c => c.accountId)).toEqual(['account']);
    expect(targets.unhandled).toHaveLength(501);
  }, 60_000);

  it('a close-all can\'t run without the actual-copy half: refused before anything changes', async () => {
    await expect(service(undefined).apply({ scope: 'platform', command: 'close_positions', expectedRevision: 0, reason: 'kill switch' }, admin))
      .rejects.toMatchObject({ status: 409, response: { code: 'close_all_unavailable' } });
    expect(await events()).toEqual([]);
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'active' });
  });

  it('a close-all whose stops never started (the api died after its commit) is resumed by the worker with the same stop keys', async () => {
    const [event] = await db.insert(schema.copyControlEvents).values({ scope: 'platform', scopeId: 0, command: 'close_positions', revision: 7, actorUserId: null, reason: 'kill switch',
      result: { cancelledOrders: 0, closeOrders: 0, liveCloseAll: 'pending' }, createdAt: new Date(now) }).returning();
    system.now = () => now + CLOSE_ALL_RESUME_AFTER_MS - 1;
    expect(await system.resumePendingCloseAll()).toEqual([]);
    system.now = () => now + CLOSE_ALL_RESUME_AFTER_MS + 1;
    // Copies started after the close-all are not its business.
    await db.update(schema.copyStrategies).set({ createdAt: new Date(now - 1000) });
    expect(await system.resumePendingCloseAll()).toEqual([expect.objectContaining({ event: String(event!.id), liveStops: 1, complete: true })]);
    expect((await db.select().from(schema.copyLiveStopOperations))[0]).toMatchObject({ idempotencyKey: 'admin-close-all-r7-mandate-2', state: 'requested' });
    expect((await db.select().from(schema.copyControlEvents).where(eq(schema.copyControlEvents.id, event!.id)))[0]!.result).toMatchObject({ liveCloseAll: 'done' });
    expect(await system.resumePendingCloseAll()).toEqual([]);
  });

  it('a user-scoped close-all stops only that owner\'s copies, also for an owner an admin disabled; a stale revision stops none; a pause stops none', async () => {
    await expect(controls.apply({ scope: 'user', userId: 1, command: 'close_positions', expectedRevision: 5, reason: 'stale screen' }, admin)).rejects.toMatchObject({ status: 409 });
    await controls.apply({ scope: 'platform', command: 'pause_new_risk', expectedRevision: 0, reason: 'pause only' }, admin);
    expect(await db.select().from(schema.copyLiveStopOperations)).toEqual([]);
    expect((await system.targets({ userId: 2 })).copies).toEqual([]);
    await db.update(schema.users).set({ disabledAt: new Date(now) });
    await controls.apply({ scope: 'user', userId: 1, command: 'close_positions', expectedRevision: 0, reason: 'disabled owner' }, admin);
    expect(await db.select().from(schema.copyLiveStopOperations)).toEqual([expect.objectContaining({ userId: 1, state: 'requested' })]);
  });
});
