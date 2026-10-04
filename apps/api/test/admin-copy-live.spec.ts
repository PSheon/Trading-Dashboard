import type { INestApplication } from '@nestjs/common';
import { adminAuditLogs, copyFundingOperations, copyLiveDispatches, copyLiveExecutions, copyLiveManualCloses, copyLiveStopOperations, copyStrategies, copyWalletAuthorizationEvents, copyWalletAuthorizations } from '@trading-dashboard/shared/database';
import { adminLiveAccountsSchema, adminLiveLatencySchema, adminLiveOrdersSchema, adminLiveTransfersSchema, adminRevokedLiveGrantSchema } from '@trading-dashboard/shared/contracts';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminCopyLiveController } from '../src/admin/admin-copy-live.controller.js';
import type { AuthService } from '../src/common/auth/auth.service.js';
import { CopyAdminLiveRepository } from '../src/copy/copy-admin-live.repository.js';
import { CopyAdminLiveService } from '../src/copy/copy-admin-live.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { findCurrentWalletAuthorization } from '../src/copy/live/postgres-wallet-authorizations.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, insertUser } from './db-test-utils.js';

const READ_ONLY = 'copy-live-read-only-token-0123456789abcdef';
const db = getTestDb();
let app: INestApplication, auth: AuthService, seed: Awaited<ReturnType<typeof preparationFixture>>;
const as = (token: string) => ({
  get: (p: string) => request(app.getHttpServer()).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string, body: object) => request(app.getHttpServer()).post(p).set('Authorization', `Bearer ${token}`).send(body),
});
const execution = (key: string, state: string, nonce: number, reduceOnly = false) => ({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
  cloid: `0x${key.at(-1)!.repeat(32)}`, nonce, userId: 1, strategyId: 9, state, updatedAt: new Date(now),
  record: { key, state, createdAt: now - 500, market: { coin: 'BTC' }, errorCode: state === 'unknown' ? 'exchange_order_not_yet_found' : undefined,
    action: { type: 'order', orders: [{ a: 0, b: !reduceOnly, p: '101', s: '0.1', r: reduceOnly, t: { limit: { tif: 'Ioc' } }, c: `0x${key.at(-1)!.repeat(32)}` }], grouping: 'na' } } });

beforeAll(async () => {
  vi.stubEnv('AUTH_SERVICE_TOKEN', READ_ONLY);
  vi.stubEnv('AUTH_SERVICE_PERMISSIONS', 'admin.access,copy.read');
  const privy = stubPrivy({ 'admin-token': { privyUserId: 'did:privy:live-admin', profile: { email: 'ops@example.com', walletAddress: null, embeddedWalletAddress: null } } });
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [AdminCopyLiveController], providers: [CopyAdminLiveRepository, CopyAdminLiveService, CopyLiveStopRepository, CopyLiveMandateRepository] }));
  app.get(CopyAdminLiveService).now = () => new Date(now);
});
beforeEach(async () => {
  seed = await preparationFixture(db); auth.clearCache();
  await insertUser(db, { privyUserId: 'did:privy:live-admin', email: 'ops@example.com', role: 'admin' });
});
afterAll(async () => { await app.close(); await closeTestDb(); vi.unstubAllEnvs(); });

describe('/admin/copy/live — testnet copy operations (B16) and latency (B18)', () => {
  it('lists execution wallets with agent, grant, mandate; transfers; open and unknown orders by purpose', async () => {
    await db.insert(copyFundingOperations).values({ id: '33333333-3333-4333-8333-333333333333', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'admin-fund-1', network: 'testnet',
      address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '50', nonce: now, status: 'credited', claimedAt: new Date(now), attemptedAt: new Date(now),
      evidenceHash: 'a'.repeat(64), transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '50', fee: '0' });
    await db.insert(copyLiveExecutions).values([execution('k1', 'unknown', now + 1), execution('k2', 'resting', now + 2, true), execution('k3', 'filled', now + 3), execution('k4', 'submitting', now + 4, true)]);
    await db.insert(copyLiveDispatches).values({ id: 'leg-1', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: seed.fill.id, leg: 'open', coin: 'BTC',
      state: 'submitted', executionKey: 'k1', leaderTime: new Date(now - 1000), receivedAt: new Date(now - 900) });
    await db.insert(copyLiveManualCloses).values({ id: 'close-1', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'admin-close-1', coin: 'BTC', executionKeys: ['k4'], createdAt: new Date(now), updatedAt: new Date(now) });

    const accounts = adminLiveAccountsSchema.parse((await as('admin-token').get('/admin/copy/live/accounts').expect(200)).body.data);
    expect(accounts.items).toEqual([expect.objectContaining({ accountId: 'account', userId: 1, strategyId: 9, accountAddress: seed.f.identity.accountAddress.toLowerCase(),
      agent: expect.objectContaining({ setupId: 'setup', state: 'active' }), grant: expect.objectContaining({ id: 'grant', version: 4, revokedAt: null }),
      mandate: { id: 'mandate', state: 'active', revision: 2 }, stop: null })]);
    const transfers = adminLiveTransfersSchema.parse((await as(READ_ONLY).get('/admin/copy/live/transfers').expect(200)).body.data);
    expect(transfers.items).toEqual([expect.objectContaining({ direction: 'to_account', status: 'credited', amount: '50' })]);
    const open = adminLiveOrdersSchema.parse((await as('admin-token').get('/admin/copy/live/orders').expect(200)).body.data);
    expect(Object.fromEntries(open.items.map(o => [o.key, o.purpose]))).toEqual({ k1: 'copy', k2: 'stop', k4: 'close' });
    expect(open.items.find(o => o.key === 'k1')).toMatchObject({ coin: 'BTC', side: 'B', size: '0.1', limitPrice: '101', errorCode: 'exchange_order_not_yet_found', leg: { leg: 'open', state: 'submitted' } });
    const unknown = adminLiveOrdersSchema.parse((await as('admin-token').get('/admin/copy/live/orders?state=unknown').expect(200)).body.data);
    expect(unknown.items.map(o => o.key).sort()).toEqual(['k1', 'k4']);
    expect((await as('admin-token').get('/admin/copy/live/orders?state=all').expect(200)).body.data.items).toHaveLength(4);
    await as('admin-token').get('/admin/copy/live/orders?state=bogus').expect(400);
  });

  it('measures P50/P95 from the leader fill to signal, send, answer and booking within the window', async () => {
    await db.insert(copyLiveExecutions).values([execution('k1', 'filled', now + 1), execution('k2', 'filled', now + 2)]);
    await db.insert(copyLiveDispatches).values([
      { id: 'leg-1', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: seed.fill.id, leg: 'open', coin: 'BTC', state: 'settled', executionKey: 'k1',
        leaderTime: new Date(now - 10_000), receivedAt: new Date(now - 9_900), sentAt: new Date(now - 9_500), ackedAt: new Date(now - 9_350), settledAt: new Date(now - 8_000) },
      { id: 'leg-2', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: seed.fill.id, leg: 'close', coin: 'BTC', state: 'submitted', executionKey: 'k2',
        leaderTime: new Date(now - 2 * 86_400_000), receivedAt: new Date(now - 2 * 86_400_000 + 300) },
    ]);
    const day = adminLiveLatencySchema.parse((await as('admin-token').get('/admin/copy/live/latency').expect(200)).body.data);
    expect(day).toEqual({ window: '24h', count: 1, signal: { p50: 100, p95: 100 }, sent: { p50: 500, p95: 500 }, ack: { p50: 650, p95: 650 }, settled: { p50: 2000, p95: 2000 } });
    const week = adminLiveLatencySchema.parse((await as('admin-token').get('/admin/copy/live/latency?window=7d').expect(200)).body.data);
    expect(week).toMatchObject({ count: 2, signal: { p50: 200, p95: 290 }, sent: { p50: 500, p95: 500 } });
    await db.delete(copyLiveDispatches);
    expect((await as('admin-token').get('/admin/copy/live/latency').expect(200)).body.data).toMatchObject({ count: 0, signal: { p50: null, p95: null } });
  });

  it('revokes a grant only with execution.pause: a copy that may hold positions is stopped first and the grant revoked when the stop ends; audited once, idempotent', async () => {
    await as(READ_ONLY).post('/admin/copy/live/grants/grant/revoke', { reason: 'leaked agent key' }).expect(403);
    await as('admin-token').post('/admin/copy/live/grants/grant/revoke', { reason: 'x' }).expect(400);
    await as('admin-token').post('/admin/copy/live/grants/missing/revoke', { reason: 'leaked agent key' }).expect(404);
    const first = adminRevokedLiveGrantSchema.parse((await as('admin-token').post('/admin/copy/live/grants/grant/revoke', { reason: 'leaked agent key' }).expect(200)).body.data);
    expect(first).toMatchObject({ id: 'grant', version: 4, revokedAt: null, revokeRequestedAt: new Date(now).toISOString() });
    expect(first.stopId).toMatch(/^[0-9a-f-]{36}$/);
    const again = (await as('admin-token').post('/admin/copy/live/grants/grant/revoke', { reason: 'leaked agent key' }).expect(200)).body.data;
    expect(again).toEqual(first);
    // The copy is stopping (no new risk) and its stop will close with this grant.
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: 'stopping', pauseNewRisk: true, reduceOnly: true });
    expect(await db.select({ id: copyLiveStopOperations.id, state: copyLiveStopOperations.state }).from(copyLiveStopOperations)).toEqual([{ id: first.stopId, state: 'requested' }]);
    expect((await db.select().from(copyWalletAuthorizations).where(eq(copyWalletAuthorizations.id, 'grant')))[0]).toMatchObject({ version: 4, revokedAt: null, revokeRequestedAt: new Date(now) });
    // Until then it signs reductions only.
    expect((await findCurrentWalletAuthorization(db, 'grant'))?.scopes).toEqual(['copy:reduce']);
    expect(await db.select().from(copyWalletAuthorizationEvents)).toEqual([]);
    const audit = await db.select().from(adminAuditLogs);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event: 'copy.grant.revoke', target: 'grant:grant', actorKind: 'user', beforeJson: { version: 4, revokedAt: null, userId: 1, strategyId: 9 },
      afterJson: { revokedAt: null, revokeRequestedAt: new Date(now).toISOString(), stopId: first.stopId, reason: 'leaked agent key' } });
    const accounts = (await as('admin-token').get('/admin/copy/live/accounts').expect(200)).body.data;
    expect(accounts.items[0].grant).toMatchObject({ version: 4, revokedAt: null, revokeRequestedAt: new Date(now).toISOString() });
    expect(accounts.items[0].stop).toMatchObject({ id: first.stopId, state: 'requested' });
  });

  it('revokes at once when the copy has ended (nothing left for the grant to close)', async () => {
    await db.update(copyStrategies).set({ status: 'stopped', stoppedAt: new Date(now) });
    const done = adminRevokedLiveGrantSchema.parse((await as('admin-token').post('/admin/copy/live/grants/grant/revoke', { reason: 'leaked agent key' }).expect(200)).body.data);
    expect(done).toEqual({ id: 'grant', version: 5, revokedAt: new Date(now).toISOString(), revokeRequestedAt: null, stopId: null });
    expect(await db.select({ version: copyWalletAuthorizationEvents.version, userId: copyWalletAuthorizationEvents.userId }).from(copyWalletAuthorizationEvents)).toEqual([{ version: 5, userId: 1 }]);
    expect(await db.select().from(copyLiveStopOperations)).toEqual([]);
  });
});
