import { Module } from "@nestjs/common";

import { AuthModule } from "../common/auth/auth.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { AdminOverviewService } from "./admin-overview.service.js";
import { AdminSettingsService } from "./admin-settings.service.js";
import { AdminUsersService } from "./admin-users.service.js";
import { AdminController, PublicSettingsController } from "./admin.controller.js";
import { RevenueService } from "./revenue.service.js";

/**
 * `/admin/*` (settings, users, overview, revenue) and the public
 * `GET /settings`. Owns the hourly revenue snapshot (`@Cron` on
 * RevenueService; ScheduleModule is registered once by SchedulerModule).
 * SettingsModule and DbModule are global; AuthModule gives AuthService, so
 * role and disable changes apply at once (`invalidateUser`).
 */
@Module({
  imports: [AuthModule, HyperliquidModule],
  controllers: [AdminController, PublicSettingsController],
  providers: [AdminSettingsService, AdminUsersService, AdminOverviewService, RevenueService],
  exports: [RevenueService],
})
export class AdminModule {}
