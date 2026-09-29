import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { ApiModule } from "./api/api.module.js";
import { AuthGuard } from "./common/auth/auth.guard.js";
import { DbModule } from "./db/db.module.js";
import { ImportModule } from "./import/import.module.js";
import { NotifyModule } from "./notify/notify.module.js";
import { RulesModule } from "./rules/rules.module.js";
import { SchedulerModule } from "./scheduler/scheduler.module.js";
import { WatcherModule } from "./watcher/watcher.module.js";

@Module({
  imports: [
    DbModule,
    ApiModule,
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
