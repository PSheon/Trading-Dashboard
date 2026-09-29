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

import { CurrentUser, Roles, type RequestUser } from "../common/auth/current-user.js";
import { Public } from "../common/auth/public.decorator.js";
import { SettingsService } from "../settings/settings.service.js";
import { AdminOverviewService } from "./admin-overview.service.js";
import { AdminSettingsService } from "./admin-settings.service.js";
import { AdminUsersService } from "./admin-users.service.js";
import { RevenueService } from "./revenue.service.js";
import { parseOr400 } from "./validation.js";

/**
 * Admin area (Stage 2 §6 管理). Admin-only on the class and again on each
 * route, so it holds whether the guard reads roles from the handler, the
 * class, or both. The service token counts as admin, so `user` may be a
 * service caller with no user id.
 */
@Roles("admin")
@Controller("admin")
export class AdminController {
  constructor(
    private readonly settings: AdminSettingsService,
    private readonly users: AdminUsersService,
    private readonly overviewService: AdminOverviewService,
    private readonly revenue: RevenueService,
  ) {}

  @Roles("admin")
  @Get("settings")
  getSettings(): Promise<AdminSettings> {
    return this.settings.getAll();
  }

  @Roles("admin")
  @Patch("settings")
  patchSettings(@Body() body: unknown, @CurrentUser() user: RequestUser | null): Promise<AdminSettings> {
    return this.settings.patch(body, user);
  }

  @Roles("admin")
  @Get("users")
  listUsers(@Query() query: unknown): Promise<AdminUsersResponse> {
    return this.users.list(query);
  }

  @Roles("admin")
  @Patch("users/:id")
  patchUser(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser | null,
  ): Promise<AdminUser> {
    return this.users.patch(id, body, user);
  }

  @Roles("admin")
  @Get("overview")
  overview(): Promise<AdminOverview> {
    return this.overviewService.overview();
  }

  @Roles("admin")
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
