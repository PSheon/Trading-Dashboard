import { Injectable, NotFoundException } from "@nestjs/common";
import { ROLE_PERMISSIONS, type MeResponse, type PatchMeRequest } from "@trading-dashboard/shared/contracts";

import { ProfileRepository } from "./profile.repository.js";

type UserRow = NonNullable<Awaited<ReturnType<ProfileRepository["findById"]>>>;

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
  constructor(private readonly repository: ProfileRepository) {}

  async get(userId: number): Promise<MeResponse> {
    const row = await this.repository.findById(userId);
    if (!row) throw new NotFoundException("User not found");
    return toMe(row);
  }

  async patch(userId: number, patch: PatchMeRequest): Promise<MeResponse> {
    const set: Partial<Pick<UserRow, "locale" | "displayName">> = {};
    if (patch.locale !== undefined) set.locale = patch.locale;
    if (patch.displayName !== undefined) set.displayName = patch.displayName?.trim() || null;
    if (Object.keys(set).length === 0) return this.get(userId);

    const row = await this.repository.updatePreferences(userId, set);
    if (!row) throw new NotFoundException("User not found");
    return toMe(row);
  }
}
