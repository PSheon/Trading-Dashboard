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
import { AppConfig } from "../config/app-config.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { HyperliquidAgentApprovalVerifier } from "./live/hyperliquid-agent-approval.js";
import { WalletAuthorizationService } from "./live/wallet-authorization.js";
import { CopyAgentController } from "./copy-agent.controller.js";
import { CopyAgentRepository } from "./copy-agent.repository.js";
import { CopyAgentService } from "./copy-agent.service.js";
import { USER_AGENT_PROVISIONER, PrivyUserAgentProvisioner } from "./live/privy-agent-provisioner.js";
import { AGENT_APPROVAL_CLIENT, PrivyAgentApprovalClient } from "./copy-agent-exchange.client.js";
import { CopyFollowerLedger } from "./live/copy-follower-ledger.js";
import { HyperliquidFollowerReceiptReader } from "./live/follower-receipt-reader.js";
import { CopyFollowerReconciler, CopyFollowerMonitor } from "./copy-follower-monitor.service.js";
import { CopyFollowerScanRepository } from "./copy-follower-scan.repository.js";
import { CopyFollowerStatementRepository } from "./copy-follower-statement.repository.js";
import { CopyFollowerController } from "./copy-follower.controller.js";
import { CopyFollowerStatementService } from "./copy-follower-statement.service.js";
import { CopyAccountModeController } from "./copy-account-mode.controller.js";
import { CopyAccountModeRepository } from "./copy-account-mode.repository.js";
import { CopyAccountModeService, ACCOUNT_MODE_CLIENT, ACCOUNT_MODE_ABSENCE_READER } from "./copy-account-mode.service.js";
import { PrivyAccountModeClient } from "./live/privy-account-mode-client.js";
import { HyperliquidAccountModeAbsenceReader } from "./copy-account-mode-evidence.js";
import { CopyFollowerActivityRepository } from "./copy-follower-activity.repository.js";
import { CopyFollowerActivityService } from "./copy-follower-activity.service.js";
import { CopyFollowerSnapshotController } from "./copy-follower-snapshot.controller.js";
import { CopyFollowerSnapshotRepository } from "./copy-follower-snapshot.repository.js";
import { CopyFollowerSnapshotService, CopyFollowerSnapshotCollector, FOLLOWER_SNAPSHOT_READER } from "./copy-follower-snapshot.service.js";
import { HyperliquidLiveAccountObserver } from "./live/live-account-observer.js";
import { CopyLiveMandateController } from "./copy-live-mandate.controller.js";
import { CopyLiveMandateRepository } from "./copy-live-mandate.repository.js";
import { CopyLiveMandateService } from "./copy-live-mandate.service.js";

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
  controllers: [CopyController, CopyWalletController, CopyFundingController, CopyAgentController, CopyFollowerController, CopyAccountModeController, CopyFollowerSnapshotController, CopyLiveMandateController],
  providers: [
    CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
    CopyControlService, CopyStrategyService, CopyAdminReadService, CopyWorkerService, CopyAdoptionRepairService, CopyPerformanceService,
    PostgresLiveExecutionJournal, PostgresWalletAuthorizationSource,
    { provide: HyperliquidAgentApprovalVerifier, inject: [AppConfig, RequestBudgeterService],
      useFactory: (config: AppConfig, budget: RequestBudgeterService) => new HyperliquidAgentApprovalVerifier(
        config.value.hyperliquid.wallet.network, (weight) => budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(5_000) })) },
    { provide: WalletAuthorizationService, inject: [PostgresWalletAuthorizationSource, HyperliquidAgentApprovalVerifier],
      useFactory: (source: PostgresWalletAuthorizationSource, exchange: HyperliquidAgentApprovalVerifier) => new WalletAuthorizationService(source, exchange) },
    CopyWalletService, CopyWalletRepository, { provide: USER_WALLET_PROVISIONER, useClass: PrivyUserWalletProvisioner },
    CopyFundingRepository, CopyFundingService, CopyFundingExchangeClient, CopyFundingMonitor,
    CopyAgentRepository, CopyAgentService,
    CopyAccountModeRepository, CopyAccountModeService,
    { provide: ACCOUNT_MODE_CLIENT, inject: [AppConfig, RequestBudgeterService], useFactory: (config: AppConfig, budget: RequestBudgeterService) =>
      new PrivyAccountModeClient(config.value.auth, weight => budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(5_000) })) },
    { provide: ACCOUNT_MODE_ABSENCE_READER, inject: [RequestBudgeterService], useFactory: (budget: RequestBudgeterService) =>
      new HyperliquidAccountModeAbsenceReader(weight => budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(5_000) })) },
    CopyFollowerLedger, CopyFollowerScanRepository, CopyFollowerReconciler, CopyFollowerMonitor, CopyFollowerStatementService, CopyFollowerStatementRepository,
    CopyFollowerActivityRepository, CopyFollowerActivityService,
    CopyFollowerSnapshotRepository, CopyFollowerSnapshotService, CopyFollowerSnapshotCollector,
    CopyLiveMandateRepository, CopyLiveMandateService,
    { provide: FOLLOWER_SNAPSHOT_READER, inject: [RequestBudgeterService], useFactory: (budget: RequestBudgeterService) =>
      new HyperliquidLiveAccountObserver('testnet', weight => budget.acquire(weight, 'background', undefined, { signal: AbortSignal.timeout(5000) })) },
    { provide: HyperliquidFollowerReceiptReader, inject: [RequestBudgeterService], useFactory: (budget: RequestBudgeterService) =>
      new HyperliquidFollowerReceiptReader("testnet", weight => budget.acquire(weight, "background", undefined, { signal: AbortSignal.timeout(5_000) })) },
    { provide: USER_AGENT_PROVISIONER, inject: [AppConfig], useFactory: (config: AppConfig) => new PrivyUserAgentProvisioner({
      appId: config.value.auth.appId, appSecret: config.value.auth.appSecret, workerQuorumId: config.value.copy.agent?.workerQuorumId,
      authorizationPublicKey: config.value.copy.agent?.authorizationPublicKey }) },
    { provide: AGENT_APPROVAL_CLIENT, inject: [AppConfig, RequestBudgeterService], useFactory: (config: AppConfig, budget: RequestBudgeterService) =>
      new PrivyAgentApprovalClient(config.value.auth, weight => budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(5_000) })) },
  ],
  exports: [CopyControlService, CopyRiskPolicyService, CopyAdminReadService, PostgresLiveExecutionJournal, PostgresWalletAuthorizationSource],
})
export class CopyModule {}
