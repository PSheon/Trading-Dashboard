import { Module } from "@nestjs/common";

import { AuthModule } from "../common/auth/auth.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { NotifyModule } from "../notify/notify.module.js";
import { CopyAdminReadService } from "./copy-admin-read.service.js";
import { CopyAdoptionRepairService } from "./copy-adoption-repair.service.js";
import { CopyControlService } from "./copy-control.service.js";
import { CopyExecutionService } from "./copy-execution.service.js";
import { CopyPerformanceService } from "./copy-performance.service.js";
import { CopyMarketService } from "./copy-market.service.js";
import { CopyOrderPlanner } from "./copy-planner.service.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopySignalService } from "./copy-signal.service.js";
import { CopyStrategyService } from "./copy-strategy.service.js";
import { CopyWorkerService } from "./copy-worker.service.js";
import { CopyController } from "./copy.controller.js";
import { CopyRepository } from "./copy.repository.js";
import { PostgresLiveExecutionJournal } from "./live/postgres-live-journal.js";
import { PostgresWalletAuthorizationSource } from "./live/postgres-wallet-authorizations.js";
import { CopyWalletController } from "./copy-wallet.controller.js";
import { CopyWalletService } from "./copy-wallet.service.js";
import { CopyWalletRepository } from "./copy-wallet.repository.js";
import { PrivyUserWalletProvisioner, USER_WALLET_PROVISIONER } from "./live/privy-wallet-provisioner.js";
import { CopyFundingController } from "./copy-funding.controller.js";
import { CopyFundingRepository } from "./copy-funding.repository.js";
import { CopyFundingService } from "./copy-funding.service.js";
import { CopyFundingExchangeClient } from "./copy-funding-exchange.client.js";
import { CopyFundingMonitor } from "./copy-funding-monitor.service.js";

/**
 * Paper copy trading (Stage 4 step 3): /me/copy for the signed-in user, the
 * signal consumer, the paper executor and its worker. The admin API
 * (/admin/copy, AdminCopyController in AdminModule) uses the exported
 * CopyControlService.apply, CopyRiskPolicyService.get/put and
 * CopyAdminReadService.
 */
@Module({
  // NotifyModule: the operator's system message when an order keeps failing.
  imports: [AuthModule, HyperliquidModule, NotifyModule],
  controllers: [CopyController, CopyWalletController, CopyFundingController],
  providers: [
    CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
    CopyControlService, CopyStrategyService, CopyAdminReadService, CopyWorkerService, CopyAdoptionRepairService, CopyPerformanceService,
    PostgresLiveExecutionJournal, PostgresWalletAuthorizationSource,
    CopyWalletService, CopyWalletRepository, { provide: USER_WALLET_PROVISIONER, useClass: PrivyUserWalletProvisioner },
    CopyFundingRepository, CopyFundingService, CopyFundingExchangeClient, CopyFundingMonitor,
  ],
  exports: [CopyControlService, CopyRiskPolicyService, CopyAdminReadService, PostgresLiveExecutionJournal, PostgresWalletAuthorizationSource],
})
export class CopyModule {}
