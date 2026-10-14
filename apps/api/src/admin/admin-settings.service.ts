import { BadRequestException, HttpException, Injectable } from "@nestjs/common";
import {
  patchAdminSettingsRequestSchema,
  appSettingsKeyEnum,
  type AdminSettingsSnapshot,
  type PatchAdminSettingsRequest,
} from "@trading-dashboard/shared/contracts";

import { userIdOf, type RequestUser } from "../common/auth/current-user.js";
import { SettingsService } from "../settings/settings.service.js";
import { RevenueService } from "./revenue.service.js";
import { isZodError, parseOr400 } from "../common/http/validation.js";

/** GET/PATCH /admin/settings: validates, lowercases the builder address, and snapshots
 * revenue at once when it changes (else the page is empty for up to an hour). */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly revenue: RevenueService,
  ) {}

  getAll(): Promise<AdminSettingsSnapshot> {
    return this.settings.getSnapshot();
  }

  async patch(body: unknown, user: RequestUser | null): Promise<AdminSettingsSnapshot> {
    const request = normalize(parseOr400(patchAdminSettingsRequestSchema, body));
    for (const key of appSettingsKeyEnum) {
      if (request[key] !== undefined && request.expectedRevisions?.[key] === undefined) {
        throw new HttpException({ statusCode: 428, code: "settings_precondition_required", section: key,
          message: "Reload settings before saving; a section revision is required." }, 428);
      }
    }
    const before = (await this.settings.get("revenue")).builderAddress?.toLowerCase() ?? null;

    let saved: AdminSettingsSnapshot;
    try {
      saved = await this.settings.patch(request, userIdOf(user), user);
    } catch (error) {
      if (isZodError(error)) {
        throw new BadRequestException({ statusCode: 400, message: "Invalid settings", issues: error.issues });
      }
      throw error;
    }

    const after = saved.revenue.builderAddress;
    if (after && after !== before) this.revenue.triggerSnapshot("builder address changed");
    return saved;
  }
}

function normalize(request: PatchAdminSettingsRequest): PatchAdminSettingsRequest {
  const out: PatchAdminSettingsRequest = { ...request };
  if (typeof request.revenue?.builderAddress === "string") {
    out.revenue = { ...request.revenue, builderAddress: request.revenue.builderAddress.toLowerCase() };
  }
  return out;
}
