import { ActionRelay } from "./runtime/action-relay.js";
import { RuntimeConfigModule } from "./config/runtime-config.module.js";
import { TradersWorkerModule } from "./traders/traders-worker.module.js";
import { HttpModule } from "./common/http/http.module.js";
import { OutboxModule } from "./outbox/outbox.module.js";
import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";

import { AdminModule } from "./admin/admin.module.js";
import { ApiModule } from "./api/api.module.js";
import { AuthModule, AUTH_GUARD_PROVIDERS } from "./common/auth/auth.module.js";
import { DbModule } from "./db/db.module.js";
import { DiscoveryModule, DiscoveryWorkerModule } from "./discovery/discovery.module.js";
import { ImportModule } from "./import/import.module.js";
import { InsightsModule } from "./insights/insights.module.js";
import { NotifyModule } from "./notify/notify.module.js";
import { RulesModule } from "./rules/rules.module.js";
import { SchedulerModule } from "./scheduler/scheduler.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { TelegramModule } from "./telegram/telegram.module.js";
import { TradersModule } from "./traders/traders.module.js";
import { UsersModule } from "./users/users.module.js";
import { WatcherModule } from "./watcher/watcher.module.js";

@Module({
  imports: [RuntimeConfigModule,
    // Global (per @nestjs/event-emitter) — backs the Watcher's
    // `action.created` event that RulesModule listens for (§1 of the M2
    // task's rules-engine trigger mechanism).
    EventEmitterModule.forRoot(),
    HttpModule,
    DbModule,
    SettingsModule,
    AuthModule,
    ApiModule,
    AdminModule,
    ImportModule,
    WatcherModule,
    SchedulerModule,
    RulesModule,
    NotifyModule,
    UsersModule,
    TelegramModule,
    TradersModule,
    TradersWorkerModule,
    DiscoveryModule,
    DiscoveryWorkerModule,
    InsightsModule,
    OutboxModule,
  ],
  providers: [...AUTH_GUARD_PROVIDERS, ActionRelay],
})
export class AppModule {}
