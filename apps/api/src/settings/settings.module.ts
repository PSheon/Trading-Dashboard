import { SettingsRepository } from "./settings.repository.js";
import { Global, Module } from "@nestjs/common";

import { SettingsRelay } from "./settings-relay.js";
import { SettingsService } from "./settings.service.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";

/** Global: discovery, auth, rules and admin all read site settings. The
 * budgeter is imported so the settings can hand it the per-job caps.
 * SettingsRelay keeps every process's cache in step with saves made in
 * any other (api and worker both listen). */
@Global()
@Module({
  imports: [HyperliquidModule],
  providers: [SettingsRepository, SettingsService, SettingsRelay],
  exports: [SettingsService],
})
export class SettingsModule {}
