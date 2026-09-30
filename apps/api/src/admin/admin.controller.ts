import { ApiDoc } from "../common/decorators/http.decorator.js";
import { ResponseMessage } from "../common/decorators/http.decorator.js";
import { PatchAdminSettingsDto } from "./dto/settings.dto.js";
import { AdminUsersQueryDto, PatchAdminUserDto, AdminRevenueQueryDto } from "./dto/admin-query.dto.js";
import { UserIdParamsDto } from "../common/dto/params.dto.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { type AdminOverview, type AdminRevenueResponse, type AdminSettingsSnapshot, type AdminUser, type AdminUsersResponse, type PublicSettings } from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { Public } from "../common/auth/public.decorator.js";
import { SettingsService } from "../settings/settings.service.js";
import { AdminOverviewService } from "./admin-overview.service.js";
import { AdminSettingsService } from "./admin-settings.service.js";
import { AdminUsersService } from "./admin-users.service.js";
import { RevenueService } from "./revenue.service.js";


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
  @ApiDoc("Get settings")
  @Get("settings")
  getSettings(): Promise<AdminSettingsSnapshot> {
    return this.settings.getAll();
  }

  @RequirePermissions("settings.write")
  @ResponseMessage("Settings updated")
  @ApiDoc("Patch settings")
  @Patch("settings")
  patchSettings(@Body() body: PatchAdminSettingsDto, @CurrentUser() user: RequestUser | null): Promise<AdminSettingsSnapshot> {
    return this.settings.patch(body, user);
  }

  @RequirePermissions("users.read")
  @ApiDoc("List users")
  @Get("users")
  listUsers(@Query() query: AdminUsersQueryDto): Promise<AdminUsersResponse> {
    return this.users.list(query);
  }

  @RequirePermissions("users.manage")
  @ResponseMessage("User updated")
  @ApiDoc("Patch user")
  @Patch("users/:id")
  patchUser(
    @Param() params: UserIdParamsDto,
    @Body() body: PatchAdminUserDto,
    @CurrentUser() user: RequestUser | null,
  ): Promise<AdminUser> {
    return this.users.patch(params.id, body, user);
  }

  @RequirePermissions("overview.read")
  @ApiDoc("Overview")
  @Get("overview")
  overview(): Promise<AdminOverview> {
    return this.overviewService.overview();
  }

  @RequirePermissions("revenue.read")
  @ApiDoc("Revenue report")
  @Get("revenue")
  revenueReport(@Query() query: AdminRevenueQueryDto): Promise<AdminRevenueResponse> {
    const { range } = query;
    return this.revenue.report(range);
  }
}

/** GET /settings — the public subset, readable before anyone signs in. */
@Controller("settings")
export class PublicSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @ApiDoc("Get")
  @Get()
  get(): Promise<PublicSettings> {
    return this.settings.getPublic();
  }
}
