import { SettingsRepository } from "./settings.repository.js";
import { Global, Module } from "@nestjs/common";

import { SettingsRelay } from "./settings-relay.js";
import { SettingsService } from "./settings.service.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";

/** Global site settings. The budgeter is imported to receive the per-job caps;
 * SettingsRelay keeps every process's cache in step. */
@Global()
@Module({
  imports: [HyperliquidModule],
  providers: [SettingsRepository, SettingsService, SettingsRelay],
  exports: [SettingsService],
})
export class SettingsModule {}
