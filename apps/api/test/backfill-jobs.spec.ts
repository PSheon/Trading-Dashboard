import { afterAll, beforeEach, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import {
  backfillJobs,
  adminAuditLogs,
} from '@trading-dashboard/shared/database';
import {
  BackfillJobsRepository,
  enqueueBackfills,
} from '../src/jobs/backfill-jobs.repository.js';
import { getTestDb, truncateAll, closeTestDb } from './db-test-utils.js';
const db = getTestDb();
const repo = new BackfillJobsRepository(db);
const address = '0x' + 'ab'.repeat(20);
beforeEach(() => truncateAll(db));
afterAll(() => closeTestDb());
it('atomically queues once and rolls queue admission back with its caller', async () => {
  await expect(
    db.transaction(async (tx) => {
      await enqueueBackfills(tx, [address], 'import');
      throw Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await db.select().from(backfillJobs)).toHaveLength(0);
  await db.transaction(async (tx) => {
    await enqueueBackfills(tx, [address], 'import');
    await enqueueBackfills(tx, [address], 'favorite');
  });
  expect(await db.select().from(backfillJobs)).toHaveLength(1);
});
it('allows only one concurrent claim, recovers expired work and fences the old owner', async () => {
  await db.transaction((tx) => enqueueBackfills(tx, [address], 'import'));
  const claims = await Promise.all([repo.claim(), repo.claim()]);
  const first = claims.find(Boolean)!;
  expect(claims.filter(Boolean)).toHaveLength(1);
  await db
    .update(backfillJobs)
    .set({ leaseExpiresAt: new Date(0) })
    .where(eq(backfillJobs.id, first.id));
  const second = (await new BackfillJobsRepository(db).claim())!;
  expect(second.leaseToken).not.toBe(first.leaseToken);
  expect(await repo.complete(first, 999)).toBe(false);
  expect(await repo.complete(second, 42)).toBe(true);
  expect((await repo.list({ limit: 20 })).items[0]).toMatchObject({
    status: 'completed',
    fillsFetched: 42,
    attempts: 2,
  });
});
it('bounds attempts and audits exactly one optimistic manual retry', async () => {
  await db.transaction((tx) => enqueueBackfills(tx, [address], 'favorite'));
  for (let i = 0; i < 3; i++) {
    await db.execute(
      sql`update backfill_jobs set available_at = now() - interval '1 second'`,
    );
    const job = (await repo.claim())!;
    expect(job).toBeDefined();
    await repo.fail(job);
  }
  expect(await repo.claim()).toBeNull();
  const failed = (await repo.list({ limit: 20 })).items[0];
  expect(failed.status).toBe('failed');
  const results = await Promise.allSettled([
    repo.retry(failed.id, failed.version, null),
    repo.retry(failed.id, failed.version, null),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await db.select().from(adminAuditLogs)).toHaveLength(1);
  expect((await repo.list({ limit: 20 })).items[0]).toMatchObject({
    status: 'pending',
    attempts: 3,
    runAttempts: 0,
  });
});
it('terminally fails repeated abandoned claims instead of recovering forever', async () => {
  await db.transaction((tx) => enqueueBackfills(tx, [address], 'import'));
  for (let i = 0; i < 3; i++) {
    expect(await repo.claim()).not.toBeNull();
    await db.execute(
      sql`update backfill_jobs set lease_expires_at = now() - interval '1 second'`,
    );
  }
  expect(await repo.claim()).toBeNull();
  expect((await repo.list({ limit: 20 })).items[0]).toMatchObject({
    status: 'failed',
    lastErrorCode: 'lease_expired',
  });
});
