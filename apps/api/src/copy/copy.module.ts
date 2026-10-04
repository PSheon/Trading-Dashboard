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
import { CopyStreamService } from "./copy-stream.service.js";
import { CopyFundsRepository } from "./copy-funds.repository.js";
import { CopyFundsService } from "./copy-funds.service.js";
import { CopyFundsController } from "./copy-funds.controller.js";
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
import { CopyFollowerReconciler } from "./copy-follower-monitor.service.js";
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
import { CopyFollowerSnapshotService } from "./copy-follower-snapshot.service.js";
import { CopyLiveMandateController } from "./copy-live-mandate.controller.js";
import { CopyLiveMandateRepository } from "./copy-live-mandate.repository.js";
import { CopyLiveMandateService } from "./copy-live-mandate.service.js";
import { CopyLiveStopController } from './copy-live-stop.controller.js';
import { CopyLiveStopRepository } from './copy-live-stop.repository.js';
import { CopyLiveStopService } from './copy-live-stop.service.js';
import { CopyLiveReturnController } from './copy-live-return.controller.js';
import { CopyLiveReturnRepository } from './copy-live-return.repository.js';
import { CopyLiveReturnService } from './copy-live-return.service.js';
import { MASTER_ACTION_SIGNER, PrivyMasterActionSigner } from './live/privy-master-signer.js';
import { HyperliquidGlobalTransport } from '../hyperliquid/hyperliquid-global-transport.js';
import { HyperliquidAllDexsAccountSource } from './live/live-account-ws-source.js';

/**
 * Paper copy trading (Stage 4 step 3): /me/copy for the signed-in user, the
 * signal consumer and the paper executor. Their loops are CopyWorkerModule's
 * (the worker process only). The admin API
 * (/admin/copy, AdminCopyController in AdminModule) uses the exported
 * CopyControlService.apply, CopyRiskPolicyService.get/put and
 * CopyAdminReadService.
 */
@Module({
  // NotifyModule: the operator's system message when an order keeps failing.
  imports: [AuthModule, HyperliquidModule, NotifyModule],
  controllers: [CopyController, CopyFundsController, CopyWalletController, CopyFundingController, CopyAgentController, CopyFollowerController, CopyAccountModeController, CopyFollowerSnapshotController, CopyLiveMandateController, CopyLiveStopController, CopyLiveReturnController],
  providers: [
    CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
    CopyControlService, CopyStrategyService, CopyAdminReadService, CopyAdoptionRepairService, CopyPerformanceService, CopyStreamService, CopyFundsService, CopyFundsRepository,
    PostgresLiveExecutionJournal, PostgresWalletAuthorizationSource,
    { provide: HyperliquidAgentApprovalVerifier, inject: [AppConfig, RequestBudgeterService, HyperliquidGlobalTransport],
      useFactory: (config: AppConfig, budget: RequestBudgeterService, transport: HyperliquidGlobalTransport) => new HyperliquidAgentApprovalVerifier(
        config.value.hyperliquid.wallet.network, (weight) => budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(5_000) }), transport.fetchInfo) },
    { provide: WalletAuthorizationService, inject: [PostgresWalletAuthorizationSource, HyperliquidAgentApprovalVerifier],
      useFactory: (source: PostgresWalletAuthorizationSource, exchange: HyperliquidAgentApprovalVerifier) => new WalletAuthorizationService(source, exchange) },
    CopyWalletService, CopyWalletRepository, { provide: USER_WALLET_PROVISIONER, useClass: PrivyUserWalletProvisioner },
    CopyFundingRepository, CopyFundingService, {provide:CopyFundingExchangeClient,inject:[RequestBudgeterService,HyperliquidGlobalTransport],useFactory:(budget:RequestBudgeterService,transport:HyperliquidGlobalTransport)=>new CopyFundingExchangeClient(budget,transport)},
    CopyAgentRepository, CopyAgentService,
    CopyAccountModeRepository, CopyAccountModeService,
    { provide: ACCOUNT_MODE_CLIENT, inject: [AppConfig, RequestBudgeterService, HyperliquidGlobalTransport], useFactory: (config: AppConfig, budget: RequestBudgeterService, transport:HyperliquidGlobalTransport) =>
      new PrivyAccountModeClient(config.value.auth, weight => budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(5_000) }),undefined,Date.now,transport) },
    { provide: ACCOUNT_MODE_ABSENCE_READER, inject: [RequestBudgeterService, HyperliquidGlobalTransport], useFactory: (budget: RequestBudgeterService, transport: HyperliquidGlobalTransport) =>
      new HyperliquidAccountModeAbsenceReader(weight => budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(5_000) }), transport.fetchInfo, Date.now,
        new HyperliquidAllDexsAccountSource(Date.now, undefined, 'testnet', transport)) },
    CopyFollowerLedger, CopyFollowerScanRepository, CopyFollowerReconciler, CopyFollowerStatementService, CopyFollowerStatementRepository,
    CopyFollowerActivityRepository, CopyFollowerActivityService,
    CopyFollowerSnapshotRepository, CopyFollowerSnapshotService,
    CopyLiveMandateRepository, CopyLiveMandateService, CopyLiveStopRepository, CopyLiveStopService, CopyLiveReturnRepository, CopyLiveReturnService,
    { provide: MASTER_ACTION_SIGNER, inject: [AppConfig], useFactory: (config: AppConfig) => new PrivyMasterActionSigner(config.value.auth) },
    { provide: HyperliquidFollowerReceiptReader, inject: [RequestBudgeterService, HyperliquidGlobalTransport], useFactory: (budget: RequestBudgeterService, transport: HyperliquidGlobalTransport) =>
      new HyperliquidFollowerReceiptReader("testnet", weight => budget.acquire(weight, "background", undefined, { signal: AbortSignal.timeout(5_000) }), transport.fetchInfo) },
    { provide: USER_AGENT_PROVISIONER, inject: [AppConfig], useFactory: (config: AppConfig) => new PrivyUserAgentProvisioner({
      appId: config.value.auth.appId, appSecret: config.value.auth.appSecret, workerQuorumId: config.value.copy.agent?.workerQuorumId,
      authorizationPublicKey: config.value.copy.agent?.authorizationPublicKey }) },
    { provide: AGENT_APPROVAL_CLIENT, inject: [AppConfig, RequestBudgeterService, HyperliquidGlobalTransport], useFactory: (config: AppConfig, budget: RequestBudgeterService, transport:HyperliquidGlobalTransport) =>
      new PrivyAgentApprovalClient(config.value.auth, weight => budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(5_000) }),undefined,Date.now,transport) },
  ],
  exports: [CopyControlService, CopyRiskPolicyService, CopyAdminReadService, PostgresLiveExecutionJournal, PostgresWalletAuthorizationSource,
    // For CopyWorkerModule's loops (the worker process only).
    CopySignalService, CopyExecutionService, CopyPerformanceService, CopyFundingService, CopyFollowerReconciler, CopyFollowerSnapshotRepository,
    // For the testnet execution engine (CopyWorkerModule).
    CopyMarketService, CopyFollowerLedger, CopyFollowerScanRepository, CopyLiveReturnRepository],
})
export class CopyModule {}
