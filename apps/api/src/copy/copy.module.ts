import { Module } from "@nestjs/common";

import { AuthModule } from "../common/auth/auth.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { CopyAdminReadService } from "./copy-admin-read.service.js";
import { CopyAdoptionRepairService } from "./copy-adoption-repair.service.js";
import { CopyControlService } from "./copy-control.service.js";
import { CopyExecutionService } from "./copy-execution.service.js";
import { CopyMarketService } from "./copy-market.service.js";
import { CopyOrderPlanner } from "./copy-planner.service.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopySignalService } from "./copy-signal.service.js";
import { CopyStrategyService } from "./copy-strategy.service.js";
import { CopyWorkerService } from "./copy-worker.service.js";
import { CopyController } from "./copy.controller.js";
import { CopyRepository } from "./copy.repository.js";

/**
 * Paper copy trading (Stage 4 step 3): /me/copy for the signed-in user, the
 * signal consumer, the paper executor and its worker. The admin API is not
 * here: CopyControlService.apply, CopyRiskPolicyService.get/put and
 * CopyAdminReadService are exported for it.
 */
@Module({
  imports: [AuthModule, HyperliquidModule],
  controllers: [CopyController],
  providers: [
    CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
    CopyControlService, CopyStrategyService, CopyAdminReadService, CopyWorkerService, CopyAdoptionRepairService,
  ],
  exports: [CopyControlService, CopyRiskPolicyService, CopyAdminReadService],
})
export class CopyModule {}
