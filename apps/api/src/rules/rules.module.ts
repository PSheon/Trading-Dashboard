import { Module } from "@nestjs/common";

import { NotifyModule } from "../notify/notify.module.js";
import { IngestionModule } from "../watcher/ingestion.module.js";
import { RulesSeedService } from "./rules-seed.service.js";
import { RulesService } from "./rules.service.js";

@Module({
  imports: [IngestionModule, NotifyModule],
  providers: [RulesService, RulesSeedService],
  exports: [RulesService],
})
export class RulesModule {}
