import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";

import { AdminModule } from "./admin/admin.module.js";
import { ApiModule } from "./api/api.module.js";
import { AuthGuard } from "./common/auth/auth.guard.js";
import { DbModule } from "./db/db.module.js";
import { ImportModule } from "./import/import.module.js";
import { NotifyModule } from "./notify/notify.module.js";
import { RulesModule } from "./rules/rules.module.js";
import { SchedulerModule } from "./scheduler/scheduler.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { WatcherModule } from "./watcher/watcher.module.js";

@Module({
  imports: [
    // Global (per @nestjs/event-emitter) — backs the Watcher's
    // `action.created` event that RulesModule listens for (§1 of the M2
    // task's rules-engine trigger mechanism).
    EventEmitterModule.forRoot(),
    DbModule,
    SettingsModule,
    ApiModule,
    AdminModule,
    ImportModule,
    WatcherModule,
    SchedulerModule,
    RulesModule,
    NotifyModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule {}
