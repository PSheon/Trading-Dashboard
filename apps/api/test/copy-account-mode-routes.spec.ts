import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { accountModeOwnerConsentTypedData, copyAccountModeChallengeSchema, copyAccountModeOperationSchema, copyAccountModeOverviewSchema, httpRouteContracts } from '@trading-dashboard/shared/contracts';
import { copyAccountModeOperations, copyExecutionAccounts, copyStrategies, users } from '@trading-dashboard/shared/database';
import { CopyAccountModeController } from '../src/copy/copy-account-mode.controller.js';
import { CopyAccountModeRepository } from '../src/copy/copy-account-mode.repository.js';
import { CopyAccountModeService, ACCOUNT_MODE_CLIENT, ACCOUNT_MODE_ABSENCE_READER, type AccountModeClient, type AccountModeAbsenceReader, type AccountModeAbsenceProof } from '../src/copy/copy-account-mode.service.js';
import { USER_WALLET_PROVISIONER, type UserWalletProvisioner } from '../src/copy/live/privy-wallet-provisioner.js';
import type { AccountModeObservation } from '../src/copy/live/privy-account-mode-client.js';
import type { AuthService } from '../src/common/auth/auth.service.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll } from './db-test-utils.js';

const db = getTestDb(), owner = privateKeyToAccount(`0x${'01'.repeat(32)}`), master = privateKeyToAccount(`0x${'02'.repeat(32)}`), bob = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const address = master.address.toLowerCase(), accountId = 'mode-route-account', key = 'mode-route-preparation-001', serviceToken = 'mode-routes-service-token-0123456789';
const privy = stubPrivy({ alice: { privyUserId: 'did:privy:mode-alice' }, bob: { privyUserId: 'did:privy:mode-bob' }, expired: { privyUserId: 'did:privy:mode-alice', expiresAt: new Date(0) } });
let app: INestApplication, auth: AuthService, uid: number, strategyId: number, configured = false;
const wallets: UserWalletProvisioner = { available: true, findOwned: vi.fn(async () => ({ id: 'master', address, ownerQuorumId: 'owner', externalId: 'mode-master' })), create: vi.fn() };
const exchange: AccountModeClient = { available: true, acquire: vi.fn(async () => undefined), 
  send: vi.fn(async () => { configured = true; return { status: 'ok', response: { type: 'default' } }; }),
  observe: vi.fn(async (intent): Promise<AccountModeObservation> => ({ network: 'testnet', accountAddress: intent.accountAddress, role: 'user', abstraction: configured ? 'disabled' : 'default',
    dexAbstraction: configured ? false : null, portfolioMarginEnabled: false, earliestObservedAt: Date.now(), completedAt: Date.now(), source: 'https://api.hyperliquid-testnet.xyz/info',
    sourceDigest: `0x${'11'.repeat(32)}`, status: configured ? 'confirmed' : 'unproven', issue: configured ? null : 'account_mode_standard_unproven' })) };
const absence: AccountModeAbsenceReader = { prove: vi.fn(async (user): Promise<AccountModeAbsenceProof> => ({ network: 'testnet', accountAddress: user, observedAt: Date.now(), completedAt: Date.now(), dexes: [''], sourceDigest: '22'.repeat(32), complete: true, empty: true })) };
const path = (id: string, action: string) => `/me/copy/account-modes/${id}/${action}`;
const post = (url: string, body: object, token = 'alice') => request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);
const get = (url = '/me/copy/account-modes', token = 'alice') => request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);
async function prepare() { return copyAccountModeOperationSchema.parse((await post(`/me/copy/execution-wallets/${accountId}/mode`, { idempotencyKey: key }).expect(200)).body.data); }
beforeAll(async () => {
  vi.stubEnv('AUTH_SERVICE_TOKEN', serviceToken); vi.stubEnv('AUTH_SERVICE_PERMISSIONS', 'copy.read,execution.pause');
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyAccountModeController], providers: [CopyAccountModeService, CopyAccountModeRepository,
    { provide: USER_WALLET_PROVISIONER, useValue: wallets }, { provide: ACCOUNT_MODE_CLIENT, useValue: exchange }, { provide: ACCOUNT_MODE_ABSENCE_READER, useValue: absence }] }));
});
beforeEach(async () => {
  await truncateAll(db); auth.clearCache(); vi.clearAllMocks(); configured = false;
  uid = (await insertUser(db, { privyUserId: 'did:privy:mode-alice', embeddedWalletAddress: owner.address.toLowerCase() })).id;
  await insertUser(db, { privyUserId: 'did:privy:mode-bob', embeddedWalletAddress: bob.address.toLowerCase() });
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: bob.address.toLowerCase(), allocated: '100', cash: '100', activatedAt: new Date() }).returning())[0]!.id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: 'testnet', privyUserId: 'did:privy:mode-alice', externalId: 'mode-master', state: 'ready', address, privyWalletId: 'master', ownerQuorumId: 'owner' });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });
describe('explicit authenticated account-mode HTTP workflow', () => {
  it('rejects anonymous, invalid, expired and service tokens on every route before side effects', async () => {
    for (const token of [null, 'bad', 'expired', serviceToken]) {
      const status = token === serviceToken ? 403 : 401;
      for (const url of ['/me/copy/account-modes', `/me/copy/account-modes/by-key/${key}`]) { const call = request(app.getHttpServer()).get(url); if (token) call.set('Authorization', `Bearer ${token}`); await call.expect(status); }
      for (const [url, body] of [[`/me/copy/execution-wallets/${accountId}/mode`, { idempotencyKey: key }], ...['challenge', 'reconcile'].map(action => [path(randomUUID(), action), {}]), [path(randomUUID(), 'approve'), { consentSignature: `0x${'00'.repeat(64)}1b`, masterSignature: `0x${'00'.repeat(64)}1b` }]] as [string, object][]) {
        const call = request(app.getHttpServer()).post(url).send(body); if (token) call.set('Authorization', `Bearer ${token}`); await call.expect(status);
      }
    }
    expect(exchange.send).not.toHaveBeenCalled(); expect(wallets.findOwned).not.toHaveBeenCalled();
    expect(await db.select().from(copyAccountModeOperations)).toHaveLength(0);
  });
  it('returns registered no-store wire contracts and original key recovery without new preparation', async () => {
    const op = await prepare();
    const overview = await get().expect(200).expect('Cache-Control', 'no-store'); expect(copyAccountModeOverviewSchema.parse(overview.body.data).operations).toEqual([op]);
    const found = await get(`/me/copy/account-modes/by-key/${key}`).expect(200).expect('Cache-Control', 'no-store'); expect(copyAccountModeOperationSchema.parse(found.body.data).id).toBe(op.id);
    await get(`/me/copy/account-modes/by-key/${key}`, 'bob').expect(404);
    const registered = httpRouteContracts.filter(c => c.path.includes('account-modes') || c.path === '/me/copy/execution-wallets/:id/mode'); expect(registered).toHaveLength(6);
    expect(wallets.create).not.toHaveBeenCalled();
  });
  it("keeps owner consent separate and posts one exact master action the copy account signed in the owner's browser", async () => {
    const op = await prepare(); const c = copyAccountModeChallengeSchema.parse((await post(path(op.id, 'challenge'), {}).expect(200)).body.data);
    const signed = await owner.signTypedData(accountModeOwnerConsentTypedData(c.intent));
    // The consent alone (no copy account signature) is refused at the DTO.
    await post(path(op.id, 'approve'), { consentSignature: signed }).expect(400);
    const masterSignature = await master.signTypedData(c.masterAction.typedData as never);
    await post(path(op.id, 'approve'), { consentSignature: signed, masterSignature: await bob.signTypedData(c.masterAction.typedData as never) }).expect(403);
    const result = await post(path(op.id, 'approve'), { consentSignature: signed, masterSignature }).expect(200).expect('Cache-Control', 'no-store');
    expect(copyAccountModeOperationSchema.parse(result.body.data)).toMatchObject({ submissionState: 'accepted', targetState: 'supported' });
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exchange.send).mock.calls[0]![1]).toBe(masterSignature);
    await post(path(op.id, 'approve'), { consentSignature: signed, masterSignature }).expect(200); expect(exchange.send).toHaveBeenCalledTimes(1);
  });
  it('rejects forged actions, malformed keys/signatures and foreign account callers at DTO/auth boundaries', async () => {
    await post(`/me/copy/execution-wallets/${accountId}/mode`, { idempotencyKey: 'short' }).expect(400);
    await post(`/me/copy/execution-wallets/${accountId}/mode`, { idempotencyKey: key, abstraction: 'portfolioMargin' }).expect(400);
    const op = await prepare(); await post(path(op.id, 'approve'), { consentSignature: '0xbad' }).expect(400);
    await post(path(op.id, 'challenge'), {}, 'bob').expect(404); await post(path(op.id, 'reconcile'), {}, 'bob').expect(404);
    expect(exchange.send).not.toHaveBeenCalled();
  });
  it('blocks disabled owners even after token caching', async () => {
    await get().expect(200); await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await get().expect(401); await post(`/me/copy/execution-wallets/${accountId}/mode`, { idempotencyKey: key }).expect(401);
    expect(exchange.send).not.toHaveBeenCalled();
  });
});
