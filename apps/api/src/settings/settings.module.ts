import { Global, Module } from "@nestjs/common";

import { SettingsService } from "./settings.service.js";

/** Global: discovery, auth, rules and admin all read site settings. */
@Global()
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
