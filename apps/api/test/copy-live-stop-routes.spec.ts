import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { liveCopyStopSchema, liveCopyStopsSchema } from '@trading-dashboard/shared/contracts';
import { copyLiveStopOperations, users } from '@trading-dashboard/shared/database';
import { CopyLiveStopController } from '../src/copy/copy-live-stop.controller.js';
import { CopyLiveStopService } from '../src/copy/copy-live-stop.service.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import type { AuthService } from '../src/common/auth/auth.service.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { closeTestDb, getTestDb, insertUser } from './db-test-utils.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';

const db = getTestDb(), root = '/me/copy/live', serviceToken = 'stop-scoped-service';
const privy = stubPrivy({ alice: { privyUserId: 'did:privy:risk-source' }, bob: { privyUserId: 'did:privy:stop-other' },
  expired: { privyUserId: 'did:privy:risk-source', expiresAt: new Date(0) } });
let app: INestApplication, auth: AuthService;
const body = { idempotencyKey: 'stop-http-original-key-0001', expectedMandateRevision: 2 };
const write = (value: unknown = body, token = 'alice', mandate = 'mandate') => request(app.getHttpServer())
  .post(`${root}/mandates/${mandate}/stop`).set('Authorization', `Bearer ${token}`).send(value as object);
const read = (path: string, token = 'alice') => request(app.getHttpServer()).get(`${root}/${path}`).set('Authorization', `Bearer ${token}`);
beforeAll(async () => {
  vi.stubEnv('AUTH_SERVICE_TOKEN', serviceToken); vi.stubEnv('AUTH_SERVICE_PERMISSIONS', 'copy.read,execution.pause');
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyLiveStopController], providers: [CopyLiveStopRepository,
    CopyLiveMandateRepository, { provide: CopyLiveStopService, inject: [CopyLiveStopRepository, UnitOfWork],
      useFactory: (repo: CopyLiveStopRepository, uow: UnitOfWork) => new CopyLiveStopService(repo, uow, () => now) }] }));
});
beforeEach(async () => {
  auth.clearCache(); await preparationFixture(db); await insertUser(db, { privyUserId: 'did:privy:stop-other' });
});
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });
it('rejects anonymous, invalid, expired and service callers on every stop route', async () => {
  for (const token of [null, 'bad', 'expired', serviceToken]) {
    const expected = token === serviceToken ? 403 : 401;
    const post = request(app.getHttpServer()).post(`${root}/mandates/mandate/stop`).send(body);
    if (token) post.set('Authorization', `Bearer ${token}`); await post.expect(expected);
    for (const path of ['stops', `stops/by-key/${body.idempotencyKey}`]) {
      const get = request(app.getHttpServer()).get(`${root}/${path}`); if (token) get.set('Authorization', `Bearer ${token}`);
      await get.expect(expected);
    }
  }
  expect(await db.select().from(copyLiveStopOperations)).toEqual([]);
});
it('returns no-store exact original operation over POST and recovery without leaking signing authority', async () => {
  const original = liveCopyStopSchema.parse((await write().expect(200).expect('Cache-Control', 'no-store')).body.data);
  expect(original).toMatchObject({ state: 'requested', flatVerifiedAt: null });
  expect((await write().expect(200)).body.data).toEqual(original);
  expect((await read(`stops/by-key/${body.idempotencyKey}`).expect(200).expect('Cache-Control', 'no-store')).body.data).toEqual(original);
  const history = liveCopyStopsSchema.parse((await read('stops').expect(200).expect('Cache-Control', 'no-store')).body.data);
  expect(history).toEqual({ items: [original], truncated: false });
  expect(JSON.stringify(history)).not.toMatch(/did:privy|owner-quorum|agentWallet|targetManifest|intentDigest|consentDigest|signature|token/);
});
it('rejects stale, coerced, unsupported or forged input without recording a stop', async () => {
  for (const change of [{ expectedMandateRevision: '2' }, { expectedMandateRevision: 0 }, { expectedMandateRevision: 2147483648 },
    { idempotencyKey: 'short' }, { execute: true }, { closePositions: true }, { userId: 1 }, { destination: `0x${'77'.repeat(20)}` }])
    await write({ ...body, ...change }).expect(400);
  await write({ ...body, expectedMandateRevision: 1 }).expect(409);
  await read('stops/by-key/short').expect(400);
  expect(await db.select().from(copyLiveStopOperations)).toEqual([]);
});
it('enforces current owner on request and every recovery read, including cached disabled users', async () => {
  await write().expect(200); await write(body, 'bob').expect(404);
  await read(`stops/by-key/${body.idempotencyKey}`, 'bob').expect(404);
  expect((await read('stops', 'bob').expect(200)).body.data).toEqual({ items: [], truncated: false });
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, 1));
  await write().expect(401); await read('stops').expect(401); await read(`stops/by-key/${body.idempotencyKey}`).expect(401);
});
