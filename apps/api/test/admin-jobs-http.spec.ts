import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  backfillJobs,
  adminAuditLogs,
} from '@trading-dashboard/shared/database';
import { backfillJobsResponseSchema } from '@trading-dashboard/shared/contracts';
import { AdminJobsController } from '../src/admin/admin-jobs.controller.js';
import { BackfillJobsRepository } from '../src/jobs/backfill-jobs.repository.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import {
  closeTestDb,
  getTestDb,
  insertUser,
  truncateAll,
} from './db-test-utils.js';
const db = getTestDb();
let app: INestApplication;
const serviceToken = 'jobs-read-only-service-test-1234567890';
beforeAll(async () => {
  vi.stubEnv('AUTH_SERVICE_TOKEN', serviceToken);
  vi.stubEnv('AUTH_SERVICE_PERMISSIONS', 'jobs.read');
  await truncateAll(db);
  await insertUser(db, { privyUserId: 'did:privy:jobs-admin', role: 'admin' });
  ({ app } = await createAuthedApp({
    db,
    privy: stubPrivy({ admin: { privyUserId: 'did:privy:jobs-admin' } }),
    controllers: [AdminJobsController],
    providers: [BackfillJobsRepository],
  }));
});
afterAll(async () => {
  await app?.close();
  await truncateAll(db);
  await closeTestDb();
  vi.unstubAllEnvs();
});
it('enforces read and retry separately, validates bounds and audits queued retry', async () => {
  const [job] = await db
    .insert(backfillJobs)
    .values({
      address: '0x' + 'ab'.repeat(20),
      source: 'import',
      status: 'failed',
      version: 3,
    })
    .returning();
  await request(app.getHttpServer()).get('/admin/jobs').expect(401);
  const listed = await request(app.getHttpServer())
    .get('/admin/jobs')
    .auth(serviceToken, { type: 'bearer' })
    .expect(200);
  expect(backfillJobsResponseSchema.parse(listed.body.data).items).toHaveLength(
    1,
  );
  expect(JSON.stringify(listed.body.data)).not.toContain('leaseToken');
  await request(app.getHttpServer())
    .post(`/admin/jobs/${job.id}/retry`)
    .auth(serviceToken, { type: 'bearer' })
    .send({ expectedVersion: 3 })
    .expect(403);
  await request(app.getHttpServer())
    .get('/admin/jobs?limit=1000')
    .auth('admin', { type: 'bearer' })
    .expect(400);
  await request(app.getHttpServer())
    .post(`/admin/jobs/${job.id}/retry`)
    .auth('admin', { type: 'bearer' })
    .send({})
    .expect(400);
  const retried = await request(app.getHttpServer())
    .post(`/admin/jobs/${job.id}/retry`)
    .auth('admin', { type: 'bearer' })
    .send({ expectedVersion: 3 })
    .expect(202);
  expect(retried.body.data).toMatchObject({ status: 'pending', version: 4 });
  await request(app.getHttpServer())
    .post(`/admin/jobs/${job.id}/retry`)
    .auth('admin', { type: 'bearer' })
    .send({ expectedVersion: 3 })
    .expect(409);
  expect(await db.select().from(adminAuditLogs)).toMatchObject([
    { event: 'job.retry', actorKind: 'user' },
  ]);
});
