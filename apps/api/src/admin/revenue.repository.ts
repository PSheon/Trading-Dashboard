import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { revenueSnapshots } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { RevenuePoint } from "./revenue-daily.js";

type RevenueSnapshot = typeof revenueSnapshots.$inferInsert;

@Injectable()
export class RevenueRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async upsert(snapshot: RevenueSnapshot): Promise<void> {
    const { address: _address, takenAt: _takenAt, ...values } = snapshot;
    await this.db.insert(revenueSnapshots).values(snapshot).onConflictDoUpdate({
      target: [revenueSnapshots.address, revenueSnapshots.takenAt], set: values,
    });
  }

  async latest(address: string) {
    const [row] = await this.db.select().from(revenueSnapshots)
      .where(eq(revenueSnapshots.address, address))
      .orderBy(desc(revenueSnapshots.takenAt)).limit(1);
    return row;
  }

  /** Include the preceding observation so the first day's increase has a baseline. */
  async pointsSince(address: string, start: Date | null): Promise<RevenuePoint[]> {
    const columns = {
      takenAt: revenueSnapshots.takenAt,
      builder: revenueSnapshots.builderRewards,
      referral: revenueSnapshots.referralRewards,
    };
    const points: RevenuePoint[] = [];
    let where = eq(revenueSnapshots.address, address);
    if (start !== null) {
      // The baseline for the range's first day: the last snapshot before it.
      const [baseline] = await this.db
        .select(columns)
        .from(revenueSnapshots)
        .where(and(eq(revenueSnapshots.address, address), lt(revenueSnapshots.takenAt, start)))
        .orderBy(desc(revenueSnapshots.takenAt))
        .limit(1);
      if (baseline) points.push(baseline);
      where = and(where, gte(revenueSnapshots.takenAt, start))!;
    }
    points.push(
      ...(await this.db.select(columns).from(revenueSnapshots).where(where).orderBy(asc(revenueSnapshots.takenAt))),
    );
    return points;
  }
}
