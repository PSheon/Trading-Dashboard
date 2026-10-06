import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { copyFollowerSnapshotReadSchema } from '@trading-dashboard/shared/contracts';
import { copyExecutionAccounts, copyFollowerObservationBudget, copyStrategies, users } from '@trading-dashboard/shared/database';
import { CopyFollowerSnapshotController } from '../src/copy/copy-follower-snapshot.controller.js';
import { CopyFollowerSnapshotRepository } from '../src/copy/copy-follower-snapshot.repository.js';
import { CopyFollowerSnapshotService } from '../src/copy/copy-follower-snapshot.service.js';
import type { AuthService } from '../src/common/auth/auth.service.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll } from './db-test-utils.js';
import { fixture, now, account } from './copy-live-risk-test-utils.js';

const db = getTestDb(), accountId = 'snapshot-http-account';
const privy = stubPrivy({ alice: { privyUserId: 'did:privy:snapshot-alice' }, bob: { privyUserId: 'did:privy:snapshot-bob' } });
let app: INestApplication, auth: AuthService, userId: number, repository: CopyFollowerSnapshotRepository;
const get = (id = accountId, token: string | null = 'alice') => {
  const call = request(app.getHttpServer()).get(`/me/copy/execution-wallets/${id}/snapshot`);
  return token ? call.set('Authorization', `Bearer ${token}`) : call;
};
beforeAll(async () => {
  vi.stubEnv('AUTH_SERVICE_TOKEN', 'snapshot-service-token-0123456789012345');
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyFollowerSnapshotController], providers: [CopyFollowerSnapshotService, CopyFollowerSnapshotRepository] }));
  repository = app.get(CopyFollowerSnapshotRepository);
});
beforeEach(async () => {
  await truncateAll(db); await db.delete(copyFollowerObservationBudget); auth.clearCache();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const owner = await insertUser(db, { privyUserId: 'did:privy:snapshot-alice' }); userId = owner.id;
  await insertUser(db, { privyUserId: 'did:privy:snapshot-bob' });
  const strategy = (await db.insert(copyStrategies).values({ userId, leaderAddress: `0x${'44'.repeat(20)}`, mode: 'testnet', status: 'paused', allocated: '0', cash: '0', activatedAt: new Date(now) }).returning())[0]!;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId, strategyId: strategy.id, network: 'testnet', state: 'ready', address: account,
    privyUserId: owner.privyUserId, externalId: 'private-provider-id', privyWalletId: 'private-wallet', ownerQuorumId: 'private-quorum' });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });
async function observe() {
  const claim = await repository.claim(); expect(claim).not.toBeNull();
  expect(await repository.save(claim!, structuredClone(fixture().accountSource.snapshot))).toBe(true); return claim!;
}
it('requires an enabled owner and refuses anonymous, invalid, service and foreign sessions', async () => {
  await get(accountId, null).expect(401); await get(accountId, 'invalid').expect(401);
  await get(accountId, 'snapshot-service-token-0123456789012345').expect(403);
  const foreign = await get(accountId, 'bob').expect(404); expect(JSON.stringify(foreign.body)).not.toContain(account);
  await get('missing').expect(404); await get().expect(200);
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId)); await get().expect(401);
});
it('returns explicit unknown and private no-store cache metadata before the first observation', async () => {
  const response = await get().expect(200).expect('Cache-Control', 'no-store');
  expect(copyFollowerSnapshotReadSchema.parse(response.body.data)).toMatchObject({ mode: 'actual', status: 'unavailable', reason: 'not_observed', observation: null });
  expect(JSON.stringify(response.body)).not.toMatch(/private-provider|private-wallet|private-quorum|did:privy|"raw"|"record"/);
});
it('keeps original source times on repeat HTTP reads and marks idle evidence stale', async () => {
  await observe();
  const first = copyFollowerSnapshotReadSchema.parse((await get().expect(200)).body.data);
  expect(first).toMatchObject({ status: 'observed', freshness: 'fresh', asOf: { observedAt: now, completedAt: now }, metrics: { perpEquity: '100', roi: null, netDeposits: null } });
  vi.mocked(Date.now).mockReturnValue(now + 6000);
  const second = copyFollowerSnapshotReadSchema.parse((await get().expect(200)).body.data);
  expect(second).toMatchObject({ status: 'observed', freshness: 'stale', asOf: { observedAt: now, completedAt: now } });
});
it('reports failed refresh against retained evidence instead of returning a fabricated live zero', async () => {
  const claim = await observe(); await repository.issue(claim, 'source_unavailable');
  const response = await get().expect(200);
  expect(response.body.data).toMatchObject({ status: 'observed', freshness: 'stale', lastReadIssue: 'source_unavailable', metrics: { perpEquity: '100' } });
});
it('refuses detached master identity; another network\'s account shows no observation of this one', async () => {
  await db.update(copyExecutionAccounts).set({ network: 'mainnet' }).where(eq(copyExecutionAccounts.id, accountId));
  expect((await get().expect(200)).body.data).toMatchObject({ network: 'mainnet', status: 'unavailable' });
  await db.update(copyExecutionAccounts).set({ network: 'testnet', privyUserId: 'did:privy:detached' }).where(eq(copyExecutionAccounts.id, accountId));
  await get().expect(404);
});
it('does not accept ownership or network overrides from request query parameters', async () => {
  const response = await get().query({ userId: 999999, accountId: 'foreign-account', network: 'mainnet' }).expect(200);
  expect(response.body.data).toMatchObject({ accountId, network: 'testnet', status: 'unavailable' });
});
