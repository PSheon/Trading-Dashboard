import { type DynamicModule, Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ScheduleModule } from "@nestjs/schedule";

import { AdminModule } from "./admin/admin.module.js";
import { ApiModule } from "./api/api.module.js";
import { AuthModule, AUTH_GUARD_PROVIDERS } from "./common/auth/auth.module.js";
import { HttpModule } from "./common/http/http.module.js";
import { RuntimeConfigModule } from "./config/runtime-config.module.js";
import { CopyModule } from "./copy/copy.module.js";
import { DbModule } from "./db/db.module.js";
import { DiscoveryModule } from "./discovery/discovery.module.js";
import { ImportModule } from "./import/import.module.js";
import { InsightsModule } from "./insights/insights.module.js";
import { NotifyModule } from "./notify/notify.module.js";
import { ReferralModule } from "./referral/referral.module.js";
import { RulesModule } from "./rules/rules.module.js";
import { ActionRelayListener } from "./runtime/action-relay.js";
import { CopyFeedListener } from "./runtime/copy-feed-relay.js";
import { SettingsModule } from "./settings/settings.module.js";
import { TelegramModule } from "./telegram/telegram.module.js";
import { TradersModule } from "./traders/traders.module.js";
import { UsersModule } from "./users/users.module.js";
import { WalletModule } from "./wallet/wallet.module.js";
import { WorkerModule } from "./worker/worker.module.js";

/** Infrastructure both processes use: validated config, the database, site
 * settings (kept in step across processes) and the in-process events. */
function sharedModules() {
  return [
    RuntimeConfigModule,
    // Global (per @nestjs/event-emitter): actions stored in a process reach
    // its rules engine, streams and the relay.
    EventEmitterModule.forRoot(),
    DbModule,
    SettingsModule,
  ];
}

/**
 * One process, one job, chosen by IS_WORKER (main.ts), as in DonutMe:
 * `api()` serves HTTP and starts no background work (no ScheduleModule, no
 * worker module); `worker()` runs every schedule, loop, poller, consumer and
 * outbox drain, and serves only its health port.
 */
@Module({})
export class AppModule {
  /** The HTTP api (IS_WORKER unset). */
  static api(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ...sharedModules(),
        HttpModule,
        AuthModule,
        ApiModule,
        AdminModule,
        ImportModule,
        RulesModule,
        NotifyModule,
        UsersModule,
        WalletModule,
        CopyModule,
        ReferralModule,
        TelegramModule,
        TradersModule,
        DiscoveryModule,
        InsightsModule,
      ],
      providers: [...AUTH_GUARD_PROVIDERS, ActionRelayListener, CopyFeedListener],
    };
  }

  /** The background worker (IS_WORKER=true): an application context, no routes. */
  static worker(): DynamicModule {
    return {
      module: AppModule,
      imports: [...sharedModules(), ScheduleModule.forRoot(), WorkerModule],
    };
  }
}
