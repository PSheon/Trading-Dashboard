import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { copyStrategies, referralAttributions, referralClaims, referralCodes, referralLedger, referralPolicies, users } from '@trading-dashboard/shared/database';
import { ReferralController, ReferralPublicController } from '../src/referral/referral.controller.js';
import { ReferralService } from '../src/referral/referral.service.js';
import { ReferralRepository } from '../src/referral/referral.repository.js';
import { claimIntentHash } from '../src/referral/referral-ledger.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll } from './db-test-utils.js';

const db = getTestDb();
let app: INestApplication, repository: ReferralRepository;
let a: typeof users.$inferSelect, b: typeof users.$inferSelect, c: typeof users.$inferSelect;
const addr = `0x${'a'.repeat(40)}`;
beforeAll(async () => {
  await db.delete(referralLedger); await db.delete(referralClaims); await db.delete(referralAttributions); await db.delete(referralCodes); await db.delete(referralPolicies);
  await truncateAll(db);
  a = await insertUser(db, { privyUserId: 'did:privy:ref-a', embeddedWalletAddress: addr });
  b = await insertUser(db, { privyUserId: 'did:privy:ref-b', email: 'private-friend@example.test' });
  c = await insertUser(db, { privyUserId: 'did:privy:ref-c' });
  ({ app } = await createAuthedApp({ db, privy: stubPrivy({ a: { privyUserId: a.privyUserId }, b: { privyUserId: b.privyUserId }, c: { privyUserId: c.privyUserId } }),
    controllers: [ReferralController, ReferralPublicController], providers: [ReferralRepository, ReferralService] }));
  repository = app.get(ReferralRepository);
});
afterAll(async () => { await app?.close(); await closeTestDb(); });

it('requires a human session for private routes and truthfully reports unavailable financial capability', async () => {
  await request(app.getHttpServer()).get('/me/referral').expect(401);
  const response = await request(app.getHttpServer()).get('/me/referral').auth('a', { type: 'bearer' }).expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.data).toMatchObject({ policy: { enabled: false, rewardBps: null, minClaimUnits: null }, balances: { earned: '0', available: '0', pending: '0', claimed: '0' }, canClaim: false });
  expect(response.body.data.code).toMatch(/^[A-Z0-9]{16}$/);
  expect((await request(app.getHttpServer()).get(`/referral/check/${response.body.data.code}`).expect(200)).body.data).toEqual({ code: response.body.data.code, valid: true });
});

it('serializes concurrent code allocation, prevents takeover, and retains old aliases', async () => {
  const initial = await Promise.all([repository.overview(b.id), repository.overview(b.id)]);
  expect(initial[0]!.code).toBe(initial[1]!.code);
  await repository.setCode(a.id, 'OLDLINK'); await repository.setCode(a.id, 'NEWLINK');
  expect(await repository.check('OLDLINK')).toBe(true);
  const race = await Promise.allSettled([repository.setCode(b.id, 'RACECODE'), repository.setCode(c.id, 'RACECODE')]);
  expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(race.filter(r => r.status === 'rejected')).toHaveLength(1);
  await expect(repository.setCode(b.id, 'OLDLINK')).rejects.toThrow();
  const rows = await db.select().from(referralCodes).where(eq(referralCodes.userId, a.id));
  expect(rows.filter(r => r.isCurrent).map(r => r.code)).toEqual(['NEWLINK']);
});

it('binds once through historical aliases, rejects self/rebinding and keeps friends private', async () => {
  const first = await repository.bind(b.id, 'OLDLINK');
  expect(await repository.bind(b.id, 'NEWLINK')).toEqual(first);
  await expect(repository.bind(a.id, 'NEWLINK')).rejects.toThrow();
  const other = await repository.overview(c.id);
  await expect(repository.bind(b.id, other.code)).rejects.toThrow();
  const response = await request(app.getHttpServer()).get('/me/referral/friends').auth('a', { type: 'bearer' }).expect(200);
  expect(response.body.data).toMatchObject({ invited: 1, copying: 0, items: [{ copying: false, copyingModes: [] }] });
  expect(JSON.stringify(response.body)).not.toContain(b.email);
  expect(JSON.stringify(response.body)).not.toContain(b.privyUserId);
  expect((await request(app.getHttpServer()).get('/me/referral/friends').auth('c', { type: 'bearer' }).expect(200)).body.data.items).toEqual([]);
});

it('enforces server-created account eligibility and never trusts browser timestamps', async () => {
  const old = await insertUser(db, { createdAt: new Date(Date.now() - 3600000) });
  await expect(repository.bind(old.id, 'NEWLINK')).rejects.toThrow('The referral binding window has closed');
  await request(app.getHttpServer()).post('/me/referral/bind').auth('c', { type: 'bearer' })
    .send({ code: 'NEWLINK', boundAt: new Date().toISOString(), userId: b.id }).expect(400);
});

it('original owner claim replays despite zero availability and disabled payout; foreign owners get 404', async () => {
  const key = randomUUID(), id = randomUUID(), now = new Date();
  const intent = { id, ownerId: String(a.id), key, amountUnits: '10000000', network: 'mainnet', token: 'USDC', destination: addr };
  await db.insert(referralClaims).values({ id, userId: a.id, key, amountUnits: intent.amountUnits, network: 'mainnet', token: 'USDC', destination: addr,
    requestHash: claimIntentHash(intent), policyVersion: 'referral-attribution-v1', status: 'unknown', attemptId: 'original-attempt', createdAt: now, updatedAt: now });
  const eventId = randomUUID();
  for (const bucket of ['earned', 'pending'] as const) await db.insert(referralLedger).values({ id: randomUUID(), userId: a.id, eventId, bucket, amountUnits: intent.amountUnits, claimId: id, createdAt: now });
  const response = await request(app.getHttpServer()).post('/me/referral/claims').auth('a', { type: 'bearer' }).send({ idempotencyKey: key }).expect(200);
  expect(response.body.data).toMatchObject({ id, status: 'unknown', destination: addr });
  const recovered = await request(app.getHttpServer()).get(`/me/referral/claims/by-key/${key}`).auth('a', { type: 'bearer' }).expect(200);
  expect(recovered.body.data).toEqual(response.body.data);
  expect(recovered.headers['cache-control']).toBe('no-store');
  await request(app.getHttpServer()).get(`/me/referral/claims/by-key/${key}`).auth('b', { type: 'bearer' }).expect(404);
  await request(app.getHttpServer()).get(`/me/referral/claims/by-key/${key}`).expect(401);
  await request(app.getHttpServer()).get(`/me/referral/claims/${id}`).auth('b', { type: 'bearer' }).expect(404);
  await request(app.getHttpServer()).post('/me/referral/claims').auth('a', { type: 'bearer' }).send({ idempotencyKey: randomUUID() }).expect(503);
  expect(await db.select().from(referralClaims)).toHaveLength(1);
  const summary = await repository.overview(a.id);
  expect(summary.balances).toEqual({ earned: '10000000', available: '0', pending: '10000000', claimed: '0' });
  await db.update(users).set({ embeddedWalletAddress: `0x${'d'.repeat(40)}` }).where(eq(users.id, a.id));
  expect(await repository.claim(a.id, key)).toMatchObject({ id, destination: addr });
});

it('rejects corrupted original intent rather than treating a changed destination as a replay', async () => {
  const [claim] = await db.select().from(referralClaims);
  await db.update(referralClaims).set({ destination: `0x${'e'.repeat(40)}` }).where(eq(referralClaims.id, claim!.id));
  await expect(repository.claim(a.id, claim!.key)).rejects.toThrow('Referral claim requires reconciliation');
  await request(app.getHttpServer()).get(`/me/referral/claims/by-key/${claim!.key}`).auth('a', { type: 'bearer' }).expect(503);
  await request(app.getHttpServer()).get(`/me/referral/claims/${claim!.id}`).auth('a', { type: 'bearer' }).expect(503);
  await request(app.getHttpServer()).get('/me/referral/claims').auth('a', { type: 'bearer' }).expect(503);
});

it('validates code and pagination inputs and exposes no private route as public', async () => {
  for (const code of ['ADMIN', '../bad', 'X'.repeat(17)]) await request(app.getHttpServer()).post('/me/referral/code').auth('a', { type: 'bearer' }).send({ code }).expect(400);
  await request(app.getHttpServer()).get('/me/referral/claims?limit=999').auth('a', { type: 'bearer' }).expect(400);
  await request(app.getHttpServer()).get('/me/referral/friends?cursor=invalid').auth('a', { type: 'bearer' }).expect(400);
  await request(app.getHttpServer()).get('/me/referral/claims').expect(401);
});

it("does not let a disabled owner's code refer anyone (lock() refuses a disabled owner), as the public check says", async () => {
  const owner = await insertUser(db, { privyUserId: `did:privy:ref-disabled-${randomUUID()}` });
  await repository.setCode(owner.id, 'GONEOWNER');
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));
  expect(await repository.check('GONEOWNER')).toBe(false);
  const fresh = await insertUser(db, { privyUserId: `did:privy:ref-fresh-${randomUUID()}` });
  await expect(repository.bind(fresh.id, 'GONEOWNER')).rejects.toThrow('Referral owner not found');
  expect(await db.select().from(referralAttributions).where(eq(referralAttributions.referredUserId, fresh.id))).toEqual([]);
});


it('rejects a reverse referral edge while retaining the original binding', async () => {
  const x = await insertUser(db), y = await insertUser(db);
  const xc = (await repository.overview(x.id)).code, yc = (await repository.overview(y.id)).code;
  const first = await repository.bind(x.id, yc);
  await expect(repository.bind(y.id, xc)).rejects.toThrow('Referral relationships cannot form a cycle');
  expect(await repository.bind(x.id, yc)).toEqual(first);
  expect(await db.select().from(referralAttributions).where(eq(referralAttributions.referredUserId, y.id))).toEqual([]);
});

it('serializes three concurrent edges so the persisted referral graph remains acyclic', async () => {
  const owners = await Promise.all([insertUser(db), insertUser(db), insertUser(db)]);
  const codes = await Promise.all(owners.map(async owner => (await repository.overview(owner.id)).code));
  const results = await Promise.allSettled(owners.map((owner, i) => repository.bind(owner.id, codes[(i + 1) % 3]!)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
});

it.each(['active', 'stopped'] as const)('closes new attribution after an actual %s strategy, without excluding paper-only users', async status => {
  const owner = await insertUser(db);
  const [strategy] = await db.insert(copyStrategies).values({ userId: owner.id, leaderAddress: addr, mode: 'testnet', network: 'mainnet',
    status, stoppedAt: status === 'stopped' ? new Date() : null, allocated: '0', cash: '0', activatedAt: new Date() }).returning();
  await expect(repository.bind(owner.id, 'NEWLINK')).rejects.toThrow('Bind an invitation before starting actual copy trading');
  expect((await repository.overview(owner.id)).bindOpenUntil).toBeNull();
  await db.delete(copyStrategies).where(eq(copyStrategies.id, strategy!.id));
  await db.insert(copyStrategies).values({ userId: owner.id, leaderAddress: addr, mode: 'paper', allocated: '100', cash: '100', activatedAt: new Date() });
  expect((await repository.bind(owner.id, 'NEWLINK')).bound).toBe(true);
});

it('reports actual friend networks from persisted strategies rather than the deployment label', async () => {
  const inviter = await insertUser(db), friend = await insertUser(db);
  await repository.bind(friend.id, (await repository.overview(inviter.id)).code);
  for (const network of ['testnet', 'mainnet'] as const) await db.insert(copyStrategies).values({ userId: friend.id, leaderAddress: addr,
    mode: 'testnet', network, allocated: '0', cash: '0', activatedAt: new Date() });
  const page = await repository.friends(inviter.id, { cursor: null, limit: 10 });
  expect(page.items[0]!.copyingModes.sort()).toEqual(['mainnet', 'testnet']);
});
