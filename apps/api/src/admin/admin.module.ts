import { Module } from "@nestjs/common";

import { AdminUsersRepository } from "./admin-users.repository.js";
import { RevenueRepository } from "./revenue.repository.js";
import { AdminOverviewRepository } from "./admin-overview.repository.js";
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
  providers: [AdminOverviewRepository, AdminUsersRepository, RevenueRepository, AdminSettingsService, AdminUsersService, AdminOverviewService, RevenueService],
  exports: [RevenueService],
})
export class AdminModule {}
