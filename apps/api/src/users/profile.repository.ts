import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

type Preferences = Partial<Pick<typeof users.$inferSelect, "locale" | "displayName">>;

@Injectable()
export class ProfileRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async findById(userId: number) {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId));
    return row;
  }

  async updatePreferences(userId: number, preferences: Preferences) {
    const [row] = await this.db.update(users).set(preferences).where(eq(users.id, userId)).returning();
    return row;
  }
}
