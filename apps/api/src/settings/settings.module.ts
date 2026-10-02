import { SettingsRepository } from "./settings.repository.js";
import { Global, Module } from "@nestjs/common";

import { SettingsService } from "./settings.service.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";

/** Global: discovery, auth, rules and admin all read site settings. The
 * budgeter is imported so the settings can hand it the per-job caps. */
@Global()
@Module({
  imports: [HyperliquidModule],
  providers: [SettingsRepository, SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
