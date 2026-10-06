import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { adminSettingsSchema, DEFAULT_COPY_RISK_LIMITS, httpRouteContracts, liveCopyMandateSchema, liveCopyOverviewSchema } from '@trading-dashboard/shared/contracts';
import { appSettings, copyControls, copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyLiveMandates, copyLiveSetups, copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyStrategyVersions, copyWalletAuthorizations, paperAccounts, users } from '@trading-dashboard/shared/database';
import { CopyLiveMandateController } from '../src/copy/copy-live-mandate.controller.js';
import { CopyLiveMandateService } from '../src/copy/copy-live-mandate.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { AuthService } from '../src/common/auth/auth.service.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, openCopyTrading } from './db-test-utils.js';
const db = getTestDb(), owner = privateKeyToAccount(`0x${'01'.repeat(32)}`), foreign = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const accountId = 'mandate-master', address = `0x${'22'.repeat(20)}`, agentAddress = `0x${'33'.repeat(20)}`, leader = `0x${'44'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'fixed' as const, perTradeUsd: 100, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const serviceToken = 'mandate-route-service-token-0123456789';
const privy = stubPrivy({ alice: { privyUserId: 'did:privy:mandate-route-owner' }, bob: { privyUserId: 'did:privy:mandate-route-other' }, expired: { privyUserId: 'did:privy:mandate-route-owner', expiresAt: new Date(0) }, successor: { privyUserId: 'did:privy:mandate-route-successor' } });
let app: INestApplication, auth: AuthService, uid: number, sid: number, clock: number;
const root = '/me/copy/live', setupId = '00000000-0000-4000-8000-0000000000a1';
const post = (url: string, body: object, token = 'alice') => request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);
const get = (token = 'alice') => request(app.getHttpServer()).get(root).set('Authorization', `Bearer ${token}`);
/** The one way a generation becomes active: a one-click setup's consent
 * (`prepareFromSetup` prepares and activates it in one transaction). */
async function activeMandate() {
  const repository = app.get(CopyLiveMandateRepository), uow = new UnitOfWork(db);
  await db.insert(copyLiveSetups).values({ id: setupId, userId: uid, strategyId: sid, kind: 'start', idempotencyKey: 'route-live-setup-key-0001', leaderAddress: leader, sourceNetwork: 'testnet', budgetUsd: '100', settings });
  const prepared = await uow.run(tx => repository.prepare(tx, uid, accountId, 'route-generation-key-0001', Date.now));
  return liveCopyMandateSchema.parse(repository.wire(await uow.run(tx => repository.activate(tx, prepared, { liveSetupId: setupId, consentDigest: 'c'.repeat(64) }, Date.now()))));
}
beforeAll(async () => {
  vi.stubEnv('AUTH_SERVICE_TOKEN', serviceToken); vi.stubEnv('AUTH_SERVICE_PERMISSIONS', 'copy.read,execution.pause');
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyLiveMandateController], providers: [CopyLiveMandateService, CopyLiveMandateRepository] }));
});
beforeEach(async () => {
  auth.clearCache();
  await truncateAll(db); clock = Date.now();
  uid = (await insertUser(db, { privyUserId: 'did:privy:mandate-route-owner', embeddedWalletAddress: owner.address.toLowerCase() })).id;
  await openCopyTrading(db);
  await db.insert(copyControls).values([{ scope: 'platform', scopeId: 0 }, { scope: 'user', scopeId: uid }]);
  await db.insert(appSettings).values({ key: 'revenue', value: adminSettingsSchema.shape.revenue.parse({}) });
  await db.insert(copyRiskPolicies).values({ limits: { ...DEFAULT_COPY_RISK_LIMITS }, reason: 'explicit live policy', createdByUserId: uid });
  sid = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: leader, mode: 'testnet', status: 'paused', pauseNewRisk: true,
    allocated: '0', cash: '0', activatedAt: new Date(clock) }).returning())[0].id;
  await db.insert(copyStrategyVersions).values({ strategyId: sid, version: 1, settings, createdByUserId: uid });
  await db.insert(copyLiveStrategyConfigs).values({ strategyId: sid, userId: uid, idempotencyKey: 'fixture-draft-key-0001', sourceNetwork: 'testnet', budgetUsd: '100', strategyVersion: 1 });
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId: sid, network: 'testnet', privyUserId: 'did:privy:mandate-route-owner',
    externalId: 'mandate-master-external', state: 'ready', address, privyWalletId: 'privy-master', ownerQuorumId: 'owner-quorum' });
  const expiresAt = new Date(clock + 86400000);
  await db.insert(copyExecutionWallets).values({ id: 'mandate-execution-wallet', userId: uid, strategyId: sid, network: 'testnet', accountAddress: address,
    privyWalletId: 'privy-agent', privyOwnerId: 'owner-quorum', signerAddress: agentAddress });
  await db.insert(copyWalletAuthorizations).values({ id: 'mandate-grant', walletId: 'mandate-execution-wallet', version: 1, scopes: ['copy:trade', 'copy:reduce'],
    validFrom: new Date(clock - 1000), expiresAt, exchangeApprovedAt: new Date(clock - 100) });
  await db.insert(copyAgentSetups).values({ id: 'mandate-setup', userId: uid, strategyId: sid, accountId, network: 'testnet', idempotencyKey: 'mandate-setup-key-0001',
    validForDays: 1, externalId: 'mandate-agent-external', policyAttemptId: 'mandate-policy-attempt', workerQuorumId: 'worker-quorum',
    policyId: 'restricted-policy', policyFingerprint: 'a'.repeat(64), agentWalletId: 'privy-agent', agentOwnerQuorumId: 'owner-quorum', agentAddress,
    accountAddress: address, accountWalletId: 'privy-master', accountOwnerQuorumId: 'owner-quorum', state: 'active', authorizationId: 'mandate-grant',
    expiresAt, createdAt: new Date(clock - 1000), updatedAt: new Date(clock - 100) });
  await insertUser(db, { privyUserId: 'did:privy:mandate-route-other', embeddedWalletAddress: foreign.address.toLowerCase() });
});
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });

describe('authenticated local live mandate HTTP routes', () => {
  it('rejects anonymous/invalid/expired/service callers on every route without creating authority', async () => {
    for (const token of [null, 'bad', 'expired', serviceToken]) {
      const expected = token === serviceToken ? 403 : 401;
      const read = request(app.getHttpServer()).get(root); if (token) read.set('Authorization', `Bearer ${token}`); await read.expect(expected);
      for (const action of ['pause', 'resume', 'revoke']) {
        const write = request(app.getHttpServer()).post(`${root}/mandates/unknown/${action}`).send({}); if (token) write.set('Authorization', `Bearer ${token}`); await write.expect(expected);
      }
    }
    expect(await db.select().from(copyLiveMandates)).toEqual([]); expect(await db.select().from(copyStrategies)).toHaveLength(1);
  });
  it('returns no-store exact wire for the overview and local barriers, keeping paper cash and automatic execution absent', async () => {
    const active = await activeMandate();
    expect(active.state).toBe('active');
    const overview = liveCopyOverviewSchema.parse((await get().expect(200).expect('Cache-Control', 'no-store')).body.data);
    expect(overview.capabilities.automaticExecution).toBe(false); expect(overview.mandates).toEqual([active]);
    expect(JSON.stringify(overview)).not.toMatch(/did:privy|owner-quorum|privy-agent|worker-quorum|restricted-policy|intentDigest|consentDigest/);
    expect(await db.select().from(paperAccounts)).toEqual([]);
    for (const action of ['pause', 'revoke']) expect(liveCopyMandateSchema.parse((await post(`${root}/mandates/${active.id}/${action}`, {}).expect(200).expect('Cache-Control', 'no-store')).body.data).state).toBe(action === 'pause' ? 'paused' : 'revoked');
  });
  it('rejects extra action fields on local barriers rather than implying a financial close', async () => {
    const active = await activeMandate();
    for (const action of ['pause', 'resume', 'revoke']) for (const body of [{ closePositions: true }, { '': null }, { execute: undefined, account: 'foreign' }]) await post(`${root}/mandates/${active.id}/${action}`, body).expect(400);
    expect((await db.select().from(copyLiveMandates))[0].state).toBe('active');
  });
  it('enforces cross-owner404 and rejects cached disabled owners on every route', async () => {
    const active = await activeMandate();
    for (const action of ['pause', 'resume', 'revoke']) await post(`${root}/mandates/${active.id}/${action}`, {}, 'bob').expect(404);
    expect(liveCopyOverviewSchema.parse((await get('bob').expect(200)).body.data)).toMatchObject({ strategies: [], mandates: [] });
    await get().expect(200); await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await get().expect(401);
    for (const action of ['pause', 'resume', 'revoke']) await post(`${root}/mandates/${active.id}/${action}`, {}).expect(401);
    expect((await db.select().from(copyLiveMandates))[0].state).toBe('active');
  });
});

describe('one way to start a live copy: setup, consent, worker', () => {
  // The legacy local-mandate path (create a strategy, prepare a generation,
  // sign it in the browser, approve it) is gone: /me/copy/live/setups starts
  // every live copy. Nothing is routed, documented or created for it.
  const removed: [method: 'get' | 'post', path: string, contract: string, body?: object][] = [
    ['post', `${root}/strategies`, '/me/copy/live/strategies', { idempotencyKey: 'route-fresh-draft-key-0001', leader: `0x${'55'.repeat(20)}`, sourceNetwork: 'testnet', budgetUsd: '100', settings }],
    ['get', `${root}/strategies/by-key/fixture-draft-key-0001`, '/me/copy/live/strategies/by-key/:key'],
    ['get', `${root}/mandates/by-key/route-generation-key-0001`, '/me/copy/live/mandates/by-key/:key'],
    ['get', `${root}/mandates/unknown/challenge`, '/me/copy/live/mandates/:id/challenge'],
    ['post', `${root}/execution-wallets/${accountId}/mandates`, '/me/copy/live/execution-wallets/:id/mandates', { idempotencyKey: 'route-generation-key-0001' }],
    ['post', `${root}/mandates/unknown/approve`, '/me/copy/live/mandates/:id/approve', { consentSignature: `0x${'00'.repeat(65)}` }],
  ];
  it('answers 404 on every legacy mandate route, including approve, and creates nothing', async () => {
    const active = await activeMandate();
    const routes = [...removed, ['post', `${root}/mandates/${active.id}/approve`, '/me/copy/live/mandates/:id/approve', { consentSignature: `0x${'00'.repeat(65)}` }] as const];
    for (const [method, path, , body] of routes) {
      const call = method === 'get' ? request(app.getHttpServer()).get(path) : request(app.getHttpServer()).post(path).send(body ?? {});
      await call.set('Authorization', 'Bearer alice').expect(404);
    }
    expect(await db.select().from(copyLiveMandates)).toHaveLength(1); expect(await db.select().from(copyStrategies)).toHaveLength(1);
    expect((await db.select().from(copyLiveMandates))[0]).toMatchObject({ id: active.id, state: 'active', consentKind: 'setup', liveSetupId: setupId });
  });
  it('documents none of them in the wire contracts', () => {
    const documented = new Set(httpRouteContracts.map(c => `${c.method} ${c.path}`));
    for (const [method, , contract] of removed) expect(documented.has(`${method.toUpperCase()} ${contract}`), contract).toBe(false);
    expect(documented.has('GET /me/copy/live')).toBe(true); expect(documented.has('POST /me/copy/live/setups')).toBe(true);
  });
});
