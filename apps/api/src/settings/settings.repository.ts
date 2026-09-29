import { Inject, Injectable } from "@nestjs/common";
import { appSettings } from "@trading-dashboard/shared/database";
import { type AdminSettings, type AppSettingsKey } from "@trading-dashboard/shared/contracts";
import { sql } from "drizzle-orm";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
@Injectable()
export class SettingsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  readSections(db: Pick<DrizzleDb, "select"> = this.db) { return db.select().from(appSettings); }
  async lockSections(tx: DbTransaction) { await tx.execute(sql`SELECT pg_advisory_xact_lock(73104, 1)`); }
  async saveSections(tx: DbTransaction, keys: AppSettingsKey[], value: AdminSettings, userId: number | null) {
    const updatedAt = new Date();
    for (const key of keys) {
      const row = { key, value: value[key], updatedAt, updatedByUserId: userId };
      await tx.insert(appSettings).values(row).onConflictDoUpdate({ target: appSettings.key, set: row });
    }
  }
}
