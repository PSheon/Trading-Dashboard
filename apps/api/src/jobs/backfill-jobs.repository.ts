import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, lt, lte, or, sql } from 'drizzle-orm';
import { backfillJobs } from '@trading-dashboard/shared/database';
import {
  backfillJobSchema,
  type BackfillJobsQuery,
  type BackfillJobsResponse,
} from '@trading-dashboard/shared/contracts';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import {
  recordAdminAudit,
  type AuditActor,
} from '../common/audit/admin-audit.js';

export type ClaimedBackfill = typeof backfillJobs.$inferSelect;
const MAX_ATTEMPTS = 3;
const leaseDeadline = sql`now() + interval '90 seconds'`;
/** Must be awaited inside the transaction admitting the new leader. */
export async function enqueueBackfills(
  tx: DbTransaction,
  addresses: string[],
  source: 'import' | 'favorite',
) {
  if (addresses.length)
    await tx
      .insert(backfillJobs)
      .values([...new Set(addresses)].map((address) => ({ address, source })))
      .onConflictDoNothing({
        target: [backfillJobs.chain, backfillJobs.address],
      });
}
const wire = (row: ClaimedBackfill) =>
  backfillJobSchema.parse(JSON.parse(JSON.stringify(row)));
@Injectable()
export class BackfillJobsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async claim(): Promise<ClaimedBackfill | null> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(backfillJobs)
        .set({
          status: 'failed',
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: sql`now()`,
          lastErrorCode: 'lease_expired',
          version: sql`${backfillJobs.version} + 1`,
        })
        .where(
          and(
            eq(backfillJobs.status, 'running'),
            lte(backfillJobs.leaseExpiresAt, sql`now()`),
            gte(backfillJobs.runAttempts, MAX_ATTEMPTS),
          ),
        );
      const [job] = await tx
        .select()
        .from(backfillJobs)
        .where(
          and(
            lt(backfillJobs.runAttempts, MAX_ATTEMPTS),
            or(
              and(
                eq(backfillJobs.status, 'pending'),
                lte(backfillJobs.availableAt, sql`now()`),
              ),
              and(
                eq(backfillJobs.status, 'running'),
                lte(backfillJobs.leaseExpiresAt, sql`now()`),
              ),
            ),
          ),
        )
        .orderBy(asc(backfillJobs.availableAt), asc(backfillJobs.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return null;
      const [claimed] = await tx
        .update(backfillJobs)
        .set({
          status: 'running',
          leaseToken: randomUUID(),
          leaseExpiresAt: leaseDeadline,
          attempts: job.attempts + 1,
          runAttempts: job.runAttempts + 1,
          version: job.version + 1,
          startedAt: sql`now()`,
          completedAt: null,
        })
        .where(eq(backfillJobs.id, job.id))
        .returning();
      return claimed;
    });
  }
  private owned(job: ClaimedBackfill) {
    return and(
      eq(backfillJobs.id, job.id),
      eq(backfillJobs.status, 'running'),
      eq(backfillJobs.leaseToken, job.leaseToken!),
      gt(backfillJobs.leaseExpiresAt, sql`now()`),
    );
  }
  async renew(job: ClaimedBackfill): Promise<boolean> {
    return (
      (
        await this.db
          .update(backfillJobs)
          .set({ leaseExpiresAt: leaseDeadline })
          .where(this.owned(job))
          .returning({ id: backfillJobs.id })
      ).length > 0
    );
  }
  async complete(job: ClaimedBackfill, fillsFetched: number): Promise<boolean> {
    return (
      (
        await this.db
          .update(backfillJobs)
          .set({
            status: 'completed',
            fillsFetched,
            completedAt: sql`now()`,
            lastErrorCode: null,
            leaseToken: null,
            leaseExpiresAt: null,
            version: sql`${backfillJobs.version} + 1`,
          })
          .where(this.owned(job))
          .returning({ id: backfillJobs.id })
      ).length > 0
    );
  }
  async fail(job: ClaimedBackfill): Promise<boolean> {
    const terminal = job.runAttempts >= MAX_ATTEMPTS;
    return (
      (
        await this.db
          .update(backfillJobs)
          .set({
            status: terminal ? 'failed' : 'pending',
            lastErrorCode: 'backfill_failed',
            leaseToken: null,
            leaseExpiresAt: null,
            availableAt: sql`now() + ${job.runAttempts * 60} * interval '1 second'`,
            completedAt: terminal ? sql`now()` : null,
            version: sql`${backfillJobs.version} + 1`,
          })
          .where(this.owned(job))
          .returning({ id: backfillJobs.id })
      ).length > 0
    );
  }
  async list(query: BackfillJobsQuery): Promise<BackfillJobsResponse> {
    const rows = await this.db
      .select()
      .from(backfillJobs)
      .where(
        and(
          query.status ? eq(backfillJobs.status, query.status) : undefined,
          query.beforeId ? lt(backfillJobs.id, query.beforeId) : undefined,
        ),
      )
      .orderBy(desc(backfillJobs.id))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit).map(wire);
    return {
      items,
      nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
    };
  }
  async retry(id: number, expectedVersion: number, actor: AuditActor) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(backfillJobs)
        .where(eq(backfillJobs.id, id))
        .for('update');
      if (!before) throw new NotFoundException('Job not found');
      if (before.status !== 'failed' || before.version !== expectedVersion)
        throw new ConflictException({
          code: 'job_conflict',
          message: 'Job changed. Refresh before retrying.',
        });
      const [after] = await tx
        .update(backfillJobs)
        .set({
          status: 'pending',
          runAttempts: 0,
          availableAt: sql`now()`,
          startedAt: null,
          completedAt: null,
          fillsFetched: null,
          leaseToken: null,
          leaseExpiresAt: null,
          version: before.version + 1,
        })
        .where(eq(backfillJobs.id, id))
        .returning();
      await recordAdminAudit(
        tx,
        actor,
        'job.retry',
        String(id),
        { status: before.status, version: before.version },
        { status: after.status, version: after.version },
      );
      return wire(after);
    });
  }
}
