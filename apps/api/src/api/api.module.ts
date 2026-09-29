import { Module } from "@nestjs/common";

import { ActionsModule } from "./actions/actions.module.js";
import { AlertRulesModule } from "./alert-rules/alert-rules.module.js";
import { AlertsModule } from "./alerts/alerts.module.js";
import { HealthModule } from "./health/health.module.js";
import { LeadersModule } from "./leaders/leaders.module.js";
import { ListsModule } from "./lists/lists.module.js";

/**
 * REST surface Next.js talks to (§7: "Next.js 只透過 REST 讀資料與上傳 CSV").
 * Aggregates the read-side feature modules; ImportModule (the write side
 * for A1 uploads) is wired separately in AppModule.
 */
@Module({
  imports: [
    LeadersModule,
    ActionsModule,
    AlertsModule,
    AlertRulesModule,
    ListsModule,
    HealthModule,
  ],
})
export class ApiModule {}
