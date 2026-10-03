import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { adminSettingsSchema, DEFAULT_COPY_RISK_LIMITS, liveCopyMandateOwnerTypedData, liveCopyMandateChallengeSchema, liveCopyMandateSchema, liveCopyOverviewSchema, liveCopyStrategySchema } from '@trading-dashboard/shared/contracts';
import { appSettings, copyControls, copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyLiveMandates, copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyStrategyVersions, copyWalletAuthorizations, paperAccounts, users } from '@trading-dashboard/shared/database';
import { CopyLiveMandateController } from '../src/copy/copy-live-mandate.controller.js';
import { CopyLiveMandateService } from '../src/copy/copy-live-mandate.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import type { AuthService } from '../src/common/auth/auth.service.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, openCopyTrading } from './db-test-utils.js';
const db = getTestDb(), owner = privateKeyToAccount(`0x${'01'.repeat(32)}`), foreign = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const accountId = 'mandate-master', address = `0x${'22'.repeat(20)}`, agentAddress = `0x${'33'.repeat(20)}`, leader = `0x${'44'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'fixed' as const, perTradeUsd: 100, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const serviceToken = 'mandate-route-service-token-0123456789';
const privy = stubPrivy({ alice: { privyUserId: 'did:privy:mandate-route-owner' }, bob: { privyUserId: 'did:privy:mandate-route-other' }, expired: { privyUserId: 'did:privy:mandate-route-owner', expiresAt: new Date(0) }, successor: { privyUserId: 'did:privy:mandate-route-successor' } });
let app: INestApplication, auth: AuthService, uid: number, sid: number, clock: number;
const root = '/me/copy/live', preparation = `${root}/execution-wallets/${accountId}/mandates`;
const post = (url: string, body: object, token = 'alice') => request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);
const get = (token = 'alice') => request(app.getHttpServer()).get(root).set('Authorization', `Bearer ${token}`);
const draft = { idempotencyKey: 'route-fresh-draft-key-0001', leader: `0x${'55'.repeat(20)}`, sourceNetwork: 'testnet', budgetUsd: '100', settings };
async function prepare() { return liveCopyMandateChallengeSchema.parse((await post(preparation, { idempotencyKey: 'route-generation-key-0001' }).expect(200).expect('Cache-Control', 'no-store')).body.data); }
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
      for (const [path, body] of [[`${root}/strategies`, draft], [preparation, { idempotencyKey: 'route-generation-key-0001' }], ...['pause', 'revoke'].map(action => [`${root}/mandates/unknown/${action}`, {}]), [`${root}/mandates/unknown/approve`, { consentSignature: `0x${'00'.repeat(65)}` }]] as [string, object][]) {
        const write = request(app.getHttpServer()).post(path).send(body); if (token) write.set('Authorization', `Bearer ${token}`); await write.expect(expected);
      }
    }
    expect(await db.select().from(copyLiveMandates)).toEqual([]); expect(await db.select().from(copyStrategies)).toHaveLength(1);
  });
  it('returns no-store exact wire and local active acknowledgment, keeping paper cash and automatic execution absent', async () => {
    const created = liveCopyStrategySchema.parse((await post(`${root}/strategies`, draft).expect(200).expect('Cache-Control', 'no-store')).body.data);
    expect(created).toMatchObject({ mode: 'actual', network: 'testnet', status: 'paused', pauseNewRisk: true });
    const challenge = await prepare();
    const signature = await owner.signTypedData(liveCopyMandateOwnerTypedData(challenge.intent));
    const approved = liveCopyMandateSchema.parse((await post(`${root}/mandates/${challenge.mandate.id}/approve`, { consentSignature: signature }).expect(200).expect('Cache-Control', 'no-store')).body.data);
    expect(approved.state).toBe('active');
    const overview = liveCopyOverviewSchema.parse((await get().expect(200).expect('Cache-Control', 'no-store')).body.data);
    expect(overview.capabilities.automaticExecution).toBe(false); expect(overview.mandates).toEqual([approved]);
    expect(JSON.stringify(overview)).not.toMatch(/did:privy|owner-quorum|privy-agent|worker-quorum|restricted-policy|intentDigest|consentDigest/);
    expect(await db.select().from(paperAccounts)).toEqual([]);
    for (const action of ['pause', 'revoke']) expect(liveCopyMandateSchema.parse((await post(`${root}/mandates/${approved.id}/${action}`, {}).expect(200).expect('Cache-Control', 'no-store')).body.data).state).toBe(action === 'pause' ? 'paused' : 'revoked');
  });
  it('rejects malformed nested bodies, unsupported mainnet, forged extra fields and foreign signature', async () => {
    for (const body of [{ ...draft, budgetUsd: 100 }, { ...draft, settings: { ...settings, perTradeUsd: null } }, { ...draft, settings: { ...settings, signer: agentAddress } }, { ...draft, sourceNetwork: 'mainnet' }, { ...draft, userId: uid }]) await post(`${root}/strategies`, body).expect(400);
    await post(preparation, { idempotencyKey: 'short' }).expect(400);
    await post(preparation, { idempotencyKey: 'route-generation-key-0001', execute: true }).expect(400);
    const challenge = await prepare();
    await post(`${root}/mandates/${challenge.mandate.id}/approve`, { consentSignature: '0xbad' }).expect(400);
    await post(`${root}/mandates/${challenge.mandate.id}/approve`, { consentSignature: await foreign.signTypedData(liveCopyMandateOwnerTypedData(challenge.intent)) }).expect(403);
    await post(`${root}/mandates/${challenge.mandate.id}/approve`, { consentSignature: await owner.signTypedData(liveCopyMandateOwnerTypedData(challenge.intent)), funds: '100' }).expect(400);
    expect((await db.select().from(copyLiveMandates))[0].state).toBe('prepared');
  });
  it('rejects extra action fields on local barriers rather than implying a financial close', async () => {
    const c = await prepare(), signature = await owner.signTypedData(liveCopyMandateOwnerTypedData(c.intent));
    await post(`${root}/mandates/${c.mandate.id}/approve`, { consentSignature: signature }).expect(200);
    for (const action of ['pause', 'revoke']) for (const body of [{ closePositions: true }, { '': null }, { execute: undefined, account: 'foreign' }]) await post(`${root}/mandates/${c.mandate.id}/${action}`, body).expect(400);
    expect((await db.select().from(copyLiveMandates))[0].state).toBe('active');
  });
  it('enforces cross-owner404 and rejects cached disabled owners on every route', async () => {
    const challenge = await prepare();
    await post(preparation, { idempotencyKey: 'foreign-generation-key-0001' }, 'bob').expect(404);
    for (const action of ['approve', 'pause', 'revoke']) await post(`${root}/mandates/${challenge.mandate.id}/${action}`, action === 'approve' ? { consentSignature: `0x${'00'.repeat(65)}` } : {}, 'bob').expect(404);
    expect(liveCopyOverviewSchema.parse((await get('bob').expect(200)).body.data)).toMatchObject({ strategies: [], mandates: [] });
    await get().expect(200); await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await get().expect(401); await post(`${root}/strategies`, draft).expect(401); await post(preparation, { idempotencyKey: 'route-generation-key-0001' }).expect(401);
    for (const action of ['approve', 'pause', 'revoke']) await post(`${root}/mandates/${challenge.mandate.id}/${action}`, action === 'approve' ? { consentSignature: `0x${'00'.repeat(65)}` } : {}).expect(401);
  });
  it('refuses expired owner consent over HTTP without an activation cursor', async () => {
    const challenge = await prepare(); const signature = await owner.signTypedData(liveCopyMandateOwnerTypedData(challenge.intent));
    const expired = Date.now() - 1, nonce = expired - 300000;
    // Simulate a past, internally consistent immutable generation without waiting five real minutes.
    const { createHash } = await import('node:crypto');
    const intent = { ...challenge.intent, nonce, consentExpiresAt: expired };
    const parsed = (await import('@trading-dashboard/shared/contracts')).liveCopyMandateIntentSchema.parse(intent);
    await db.update(copyLiveMandates).set({ nonce, consentExpiresAt: new Date(expired), intent: parsed, intentDigest: createHash('sha256').update(JSON.stringify(parsed)).digest('hex') }).where(eq(copyLiveMandates.id, challenge.mandate.id));
    await post(`${root}/mandates/${challenge.mandate.id}/approve`, { consentSignature: signature }).expect(409);
    expect((await db.select().from(copyLiveMandates))[0]).toMatchObject({ state: 'prepared', activationCursor: null });
  });
});


describe('original local operation recovery HTTP', () => {
  it('recovers exact draft/key/id challenges without changing nonce, expiry, revision or archived state', async () => {
    const created = liveCopyStrategySchema.parse((await post(`${root}/strategies`, draft).expect(200)).body.data), c = await prepare();
    const read = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', 'Bearer alice').expect(200).expect('Cache-Control', 'no-store');
    expect(liveCopyStrategySchema.parse((await read(`${root}/strategies/by-key/${draft.idempotencyKey}`)).body.data)).toEqual(created);
    expect(liveCopyMandateChallengeSchema.parse((await read(`${root}/mandates/by-key/route-generation-key-0001`)).body.data)).toEqual(c);
    expect(liveCopyMandateChallengeSchema.parse((await read(`${root}/mandates/${c.mandate.id}/challenge`)).body.data)).toEqual(c);
    await db.update(copyLiveMandates).set({ state: 'revoked', revision: 2 });
    const before = await db.select().from(copyLiveMandates);
    const archived = liveCopyMandateChallengeSchema.parse((await read(`${root}/mandates/${c.mandate.id}/challenge`)).body.data);
    expect(archived.intent).toEqual(c.intent); expect(archived.mandate.state).toBe('revoked');
    expect((await read(`${root}/mandates/by-key/route-generation-key-0001`)).body.data).toEqual(archived);
    expect(await db.select().from(copyLiveMandates)).toEqual(before);
  });
  it('enforces auth/cross-owner/key shape/current DID on every recovery path', async () => {
    await post(`${root}/strategies`, draft).expect(200); const c = await prepare();
    const paths = [`${root}/strategies/by-key/${draft.idempotencyKey}`, `${root}/mandates/by-key/route-generation-key-0001`, `${root}/mandates/${c.mandate.id}/challenge`];
    for (const path of paths) {
      await request(app.getHttpServer()).get(path).expect(401);
      await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${serviceToken}`).expect(403);
      await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer bob').expect(404);
    }
    for (const category of ['strategies', 'mandates']) await request(app.getHttpServer()).get(`${root}/${category}/by-key/short`).set('Authorization', 'Bearer alice').expect(400);
    await db.update(users).set({ privyUserId: 'did:privy:mandate-route-successor' }).where(eq(users.id, uid));
    auth.clearCache();
    for (const path of paths.slice(1)) await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer successor').expect(409);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    for (const path of paths) await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer successor').expect(401);
    expect((await db.select().from(copyLiveMandates))[0].state).toBe('prepared');
  });
});
