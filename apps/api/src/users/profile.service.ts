import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "@trading-dashboard/shared/database";
import { ROLE_PERMISSIONS, type MeResponse, type PatchMeRequest } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

type UserRow = typeof users.$inferSelect;

function toMe(row: UserRow): MeResponse {
  return {
    id: row.id,
    privyUserId: row.privyUserId,
    email: row.email,
    walletAddress: row.walletAddress,
    displayName: row.displayName,
    role: row.role,
    permissions: [...ROLE_PERMISSIONS[row.role]],
    locale: row.locale,
    createdAt: row.createdAt,
  };
}

/** GET/PATCH /me. */
@Injectable()
export class ProfileService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async get(userId: number): Promise<MeResponse> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!row) throw new NotFoundException("User not found");
    return toMe(row);
  }

  async patch(userId: number, patch: PatchMeRequest): Promise<MeResponse> {
    const set: Partial<Pick<UserRow, "locale" | "displayName">> = {};
    if (patch.locale !== undefined) set.locale = patch.locale;
    if (patch.displayName !== undefined) set.displayName = patch.displayName?.trim() || null;
    if (Object.keys(set).length === 0) return this.get(userId);

    const [row] = await this.db.update(users).set(set).where(eq(users.id, userId)).returning();
    if (!row) throw new NotFoundException("User not found");
    return toMe(row);
  }
}
