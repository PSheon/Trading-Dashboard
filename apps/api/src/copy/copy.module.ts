import { apiSettlementProvider } from './live-worker/copy-live-api-settlement.provider.js';
import { Module } from "@nestjs/common";

import { AuthModule } from "../common/auth/auth.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { LeaderActivityModule } from "../traders/leader-activity.module.js";
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
import { CopyAdminLiveRepository } from "./copy-admin-live.repository.js";
import { CopyAdminLiveService } from "./copy-admin-live.service.js";
import { PrivyUserWalletProvisioner, USER_WALLET_PROVISIONER } from "./live/privy-wallet-provisioner.js";
import { MASTER_POLICY, PrivyMasterPolicy } from "./live/privy-master-policy.js";
import { PrivyPolicyMasterSigner, WORKER_MASTER_SIGNER } from "./live/privy-policy-master-signer.js";
import { CopyFundingController } from "./copy-funding.controller.js";
import { CopyFundingRepository } from "./copy-funding.repository.js";
import { CopyFundingService } from "./copy-funding.service.js";
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";
import { CopyFundingExchangeClient } from "./copy-funding-exchange.client.js";
import { AppConfig } from "../config/app-config.js";
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
import { CopyAccountModeService, ACCOUNT_MODE_CLIENT, ACCOUNT_MODE_ABSENCE_READER, ATTEMPT_STEP_WEIGHT } from "./copy-account-mode.service.js";
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
import { CopyLiveSystemStops } from './copy-live-stop-system.js';
import { CopyLiveStopService } from './copy-live-stop.service.js';
import { CopyLiveReturnController } from './copy-live-return.controller.js';
import { CopyLivePortfolioController } from './copy-live-portfolio.controller.js';
import { CopyLiveCloseController } from './copy-live-close.controller.js';
import { CopyLiveCloseService } from './copy-live-close.service.js';
import { CopyLiveCloseRepository } from './copy-live-close.repository.js';
import { CopyLivePortfolioRepository } from './copy-live-portfolio.repository.js';
import { CopyLiveReturnRepository } from './copy-live-return.repository.js';
import { CopyLiveReturnService } from './copy-live-return.service.js';
import { HyperliquidAllDexsAccountSource } from './live/live-account-ws-source.js';
import { assertBucketHolds, liveBudget, type LiveReserveOptions } from "../hyperliquid/hyperliquid-budget-wait.js";

/**
 * Paper copy trading (Stage 4 step 3): /me/copy for the signed-in user, the
 * signal consumer and the paper executor. Their loops are CopyWorkerModule's
 * (the worker process only). The admin API
 * (/admin/copy, AdminCopyController in AdminModule) uses the exported
 * CopyControlService.apply, CopyRiskPolicyService.get/put and
 * CopyAdminReadService.
 */
import { CopyLiveSetupController } from "./copy-live-setup.controller.js";
import { CopyLiveSetupRepository } from "./copy-live-setup.repository.js";
import { deploymentNetwork } from "./live-deployment.js";
import { CopyLiveSetupService, SETUP_REST_CAPACITY, type SetupRestCapacity } from "./copy-live-setup.service.js";
import { DEFAULT_LIVE_SETUP_TIMINGS } from "../config/live-timings.js";
import { CopyLiveSetupAbortRepository } from './copy-live-setup-abort.repository.js';
import { CopyLiveSetupAbortReturnRepository } from './copy-live-setup-abort-return.repository.js';
import { CopyLiveSetupAbortService, SETUP_ABORT_OBSERVER } from './copy-live-setup-abort.service.js';
import { HyperliquidLiveAccountObserver } from './live/live-account-observer.js';
// The wallet network's budget, transport and info client: one per process,
// provided by HyperliquidModule (re-exported here for existing imports).
export { WALLET_NETWORK_HL, walletNetworkHyperliquid, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";
/** A setup step's clients' reservations: queued (never refused at once on
 * the estimate) for at most the setup step's reserve wait
 * (AppConfig.copy.live.setup.stepBudgetMs.reserveWaitMs, inside its lease).
 * The order path keeps its own bounds (copy-live-engine, live-execution-runtime). */
const setupReserve = (config: AppConfig, network: WalletNetworkHyperliquid['network']): LiveReserveOptions =>
  ({ maxWaitMs: (config.value.copy.live?.setup ?? DEFAULT_LIVE_SETUP_TIMINGS).stepBudgetMs.reserveWaitMs, queue: true, bucket: `wallet:${network}` });

@Module({
  // NotifyModule: the operator's system message when an order keeps failing.
  imports: [AuthModule, HyperliquidModule, NotifyModule, LeaderActivityModule],
  controllers: [CopyController, CopyFundsController, CopyWalletController, CopyFundingController, CopyAgentController, CopyFollowerController, CopyAccountModeController, CopyFollowerSnapshotController, CopyLiveMandateController, CopyLiveStopController, CopyLiveReturnController, CopyLivePortfolioController, CopyLiveCloseController, CopyLiveSetupController],
  providers: [apiSettlementProvider, CopyAdminLiveRepository, CopyAdminLiveService,
    CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService,
    CopyControlService, CopyStrategyService, CopyAdminReadService, CopyAdoptionRepairService, CopyPerformanceService, CopyStreamService, CopyFundsService, CopyFundsRepository,
    PostgresLiveExecutionJournal, PostgresWalletAuthorizationSource,
    { provide: HyperliquidAgentApprovalVerifier, inject: [AppConfig, WALLET_NETWORK_HL],
      useFactory: (config: AppConfig, { budget, transport }: WalletNetworkHyperliquid) => new HyperliquidAgentApprovalVerifier(
        config.value.hyperliquid.wallet.network, liveBudget(budget, { maxWaitMs: 5_000 }), transport.fetchInfo) },
    { provide: WalletAuthorizationService, inject: [PostgresWalletAuthorizationSource, HyperliquidAgentApprovalVerifier],
      useFactory: (source: PostgresWalletAuthorizationSource, exchange: HyperliquidAgentApprovalVerifier) => new WalletAuthorizationService(source, exchange) },
    CopyWalletService, CopyWalletRepository, { provide: USER_WALLET_PROVISIONER, useClass: PrivyUserWalletProvisioner },
    { provide: MASTER_POLICY, inject: [AppConfig], useFactory: (config: AppConfig) => new PrivyMasterPolicy(config.value.auth) },
    CopyFundingRepository, CopyFundingService, {provide:CopyFundingExchangeClient,inject:[WALLET_NETWORK_HL],useFactory:({budget,transport}:WalletNetworkHyperliquid)=>new CopyFundingExchangeClient(budget,transport)},
    CopyAgentRepository, CopyAgentService,
    // A setup step's weight on the shared meter: ahead of background, within the setups' share.
    { provide: SETUP_REST_CAPACITY, inject: [WALLET_NETWORK_HL], useFactory: ({ transport }: WalletNetworkHyperliquid): SetupRestCapacity => transport },
    CopyAccountModeRepository, CopyAccountModeService,
    { provide: ACCOUNT_MODE_CLIENT, inject: [AppConfig, WALLET_NETWORK_HL], useFactory: (config: AppConfig, { budget, transport, network }: WalletNetworkHyperliquid) => {
      // A copy setup's account-mode step is reserved at once (715: the attempt and its reconcile): a
      // bucket that can never hold it would fail every setup at that step.
      // With live copy the wallet network has its own bucket on both networks.
      if (config.value.copy.live) assertBucketHolds(budget, ATTEMPT_STEP_WEIGHT, "A copy setup's account-mode step", 'Lower COPY_LIVE_WEIGHT_PER_MIN (at most 485).');
      // Weight is reserved before any evidence clock starts (reserveLive):
      // a busy bucket answers HyperliquidBudgetWait instead of stale evidence.
      // Setup steps wait in line at most their reserve wait (inside their driver's lease).
      return new PrivyAccountModeClient(config.value.auth, liveBudget(budget, setupReserve(config, network)),undefined,Date.now,transport); } },
    { provide: ACCOUNT_MODE_ABSENCE_READER, inject: [AppConfig, WALLET_NETWORK_HL], useFactory: (config: AppConfig, { budget, transport, network }: WalletNetworkHyperliquid) =>
      new HyperliquidAccountModeAbsenceReader(network, liveBudget(budget, setupReserve(config, network)), transport.fetchInfo, Date.now,
        new HyperliquidAllDexsAccountSource(Date.now, undefined, network, transport, { closeAfterRead: true }), transport) },
    CopyFollowerLedger, CopyFollowerScanRepository, CopyFollowerReconciler, CopyFollowerStatementService, CopyFollowerStatementRepository,
    CopyFollowerActivityRepository, CopyFollowerActivityService,
    CopyFollowerSnapshotRepository, CopyFollowerSnapshotService,
    CopyLiveMandateRepository, CopyLiveMandateService, CopyLiveStopRepository, CopyLiveStopService, CopyLiveSystemStops, CopyLiveReturnRepository, CopyLiveReturnService, CopyLivePortfolioRepository, CopyLiveCloseService, CopyLiveCloseRepository, CopyLiveSetupRepository, CopyLiveSetupService,
    CopyLiveSetupAbortRepository, CopyLiveSetupAbortReturnRepository, CopyLiveSetupAbortService,
    { provide: SETUP_ABORT_OBSERVER, inject: [WALLET_NETWORK_HL], useFactory: ({ budget, transport, network }: WalletNetworkHyperliquid) =>
      // Original refund proofs may queue before their evidence clock, within the
      // existing 120s abort lease. This preserves the live reserve and 5s proof.
      new HyperliquidLiveAccountObserver(network, liveBudget(budget, { maxWaitMs: 50_000 }), transport.fetchInfo, Date.now, 5000,
        new HyperliquidAllDexsAccountSource(Date.now, undefined, network, transport, { closeAfterRead: true }), 52_000) },
    { provide: WORKER_MASTER_SIGNER, inject: [AppConfig], useFactory: (config: AppConfig) => new PrivyPolicyMasterSigner({ appId: config.value.auth.appId, appSecret: config.value.auth.appSecret,
      workerQuorumId: config.value.copy.agent?.workerQuorumId, authorizationPrivateKey: config.value.copy.agent?.authorizationPrivateKey }) },
    { provide: HyperliquidFollowerReceiptReader, inject: [WALLET_NETWORK_HL], useFactory: ({ budget, transport, network }: WalletNetworkHyperliquid) =>
      // Reporting (the follower monitor's receipts and funding): the shared
      // meter's background lane too, waiting there for room like snapshots.
      new HyperliquidFollowerReceiptReader(network, liveBudget(budget, { lane: "background", maxWaitMs: 5_000 }), transport.fetchEssentialInfo,
        Date.now, weight => { if (weight > 0) budget.adjust(-weight); },
        { acquire: liveBudget(budget, { lane: "background", maxWaitMs: Math.min(180_000, budget.refillMs()) }), maxWaitMs: Math.min(180_000, budget.refillMs()) + 2000 }) },
    { provide: USER_AGENT_PROVISIONER, inject: [AppConfig], useFactory: (config: AppConfig) => new PrivyUserAgentProvisioner({
      appId: config.value.auth.appId, appSecret: config.value.auth.appSecret, workerQuorumId: config.value.copy.agent?.workerQuorumId,
      authorizationPublicKey: config.value.copy.agent?.authorizationPublicKey, network: deploymentNetwork(config) }) },
    { provide: AGENT_APPROVAL_CLIENT, inject: [AppConfig, WALLET_NETWORK_HL], useFactory: (config: AppConfig, { budget, transport, network }: WalletNetworkHyperliquid) =>
      new PrivyAgentApprovalClient(config.value.auth, liveBudget(budget, setupReserve(config, network)),undefined,Date.now,transport) },
  ],
  exports: [CopyControlService, CopyRiskPolicyService, CopyAdminReadService, CopyAdminLiveService, PostgresLiveExecutionJournal, PostgresWalletAuthorizationSource,
    // Disabling a user stops their actual copies (AdminUsersService).
    CopyLiveSystemStops,
    // For CopyWorkerModule's loops (the worker process only).
    CopySignalService, CopyExecutionService, CopyPerformanceService, CopyFundingService, CopyFollowerReconciler, CopyFollowerSnapshotRepository,
    // For the testnet execution engine (CopyWorkerModule).
    CopyMarketService, CopyFollowerLedger, CopyFollowerScanRepository, CopyLiveReturnRepository, CopyLiveSetupService, WORKER_MASTER_SIGNER],
})
export class CopyModule {}
