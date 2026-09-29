import { RequirePermissions } from "../common/auth/permissions.js";
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from "@nestjs/common";
import {
  adminRevenueQuerySchema,
  type AdminOverview,
  type AdminRevenueResponse,
  type AdminSettings,
  type AdminUser,
  type AdminUsersResponse,
  type PublicSettings,
} from "@trading-dashboard/shared";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { Public } from "../common/auth/public.decorator.js";
import { SettingsService } from "../settings/settings.service.js";
import { AdminOverviewService } from "./admin-overview.service.js";
import { AdminSettingsService } from "./admin-settings.service.js";
import { AdminUsersService } from "./admin-users.service.js";
import { RevenueService } from "./revenue.service.js";
import { parseOr400 } from "../common/http/validation.js";

/** Administrative actions require explicit permissions. Human admins receive
 * the role's catalog; service callers receive only configured scopes. */
@RequirePermissions("admin.access")
@Controller("admin")
export class AdminController {
  constructor(
    private readonly settings: AdminSettingsService,
    private readonly users: AdminUsersService,
    private readonly overviewService: AdminOverviewService,
    private readonly revenue: RevenueService,
  ) {}

  @RequirePermissions("settings.read")
  @Get("settings")
  getSettings(): Promise<AdminSettings> {
    return this.settings.getAll();
  }

  @RequirePermissions("settings.write")
  @Patch("settings")
  patchSettings(@Body() body: unknown, @CurrentUser() user: RequestUser | null): Promise<AdminSettings> {
    return this.settings.patch(body, user);
  }

  @RequirePermissions("users.read")
  @Get("users")
  listUsers(@Query() query: unknown): Promise<AdminUsersResponse> {
    return this.users.list(query);
  }

  @RequirePermissions("users.manage")
  @Patch("users/:id")
  patchUser(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser | null,
  ): Promise<AdminUser> {
    return this.users.patch(id, body, user);
  }

  @RequirePermissions("overview.read")
  @Get("overview")
  overview(): Promise<AdminOverview> {
    return this.overviewService.overview();
  }

  @RequirePermissions("revenue.read")
  @Get("revenue")
  revenueReport(@Query() query: unknown): Promise<AdminRevenueResponse> {
    const { range } = parseOr400(adminRevenueQuerySchema, query);
    return this.revenue.report(range);
  }
}

/** GET /settings — the public subset, readable before anyone signs in. */
@Controller("settings")
export class PublicSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get()
  get(): Promise<PublicSettings> {
    return this.settings.getPublic();
  }
}
