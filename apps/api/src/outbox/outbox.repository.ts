import { Inject, Injectable } from "@nestjs/common";
import { actionOutbox, actions } from "@trading-dashboard/shared/database";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

/** Durable action claims; scheduling and retry policy belong to OutboxService. */
@Injectable()
export class OutboxRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  private due(now: Date) {
    return or(and(eq(actionOutbox.status, "pending"), lte(actionOutbox.availableAt, now)),
      and(eq(actionOutbox.status, "processing"), lte(actionOutbox.lockedUntil, now)));
  }

  /** Return at most 20 candidates; callers must claim each before evaluating it. */
  findDue(now: Date) {
    return this.db.select({ id: actionOutbox.actionId }).from(actionOutbox).where(this.due(now))
      .orderBy(actionOutbox.actionId).limit(20);
  }

  /** Atomically claim a due row; undefined means it is no longer eligible. */
  async claim(id: bigint, now: Date, lockedUntil: Date) {
    const [claimed] = await this.db.update(actionOutbox).set({ status: "processing",
      attempts: sql`${actionOutbox.attempts} + 1`, lockedUntil,
    }).where(and(eq(actionOutbox.actionId, id), this.due(now))).returning();
    return claimed;
  }

  async findAction(id: bigint) {
    const [action] = await this.db.select().from(actions).where(eq(actions.id, id));
    return action;
  }

  /**
   * Record failure only for the matching claim generation. Reclaim increments
   * attempts, so a stale worker becomes a no-op rather than overwriting its successor.
   */
  async recordFailure(id: bigint, status: "failed" | "pending", availableAt: Date, claimedAttempt: number) {
    await this.db.update(actionOutbox).set({ status, lockedUntil: null, availableAt, lastError: "evaluation failed" })
      .where(and(eq(actionOutbox.actionId, id), eq(actionOutbox.status, "processing"),
        eq(actionOutbox.attempts, claimedAttempt)));
  }
}
