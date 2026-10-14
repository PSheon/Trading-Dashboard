import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { liveBudget } from "../hyperliquid/hyperliquid-budget-wait.js";
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";
import { NotifyModule } from "../notify/notify.module.js";
import { CopyExecutionService } from "./copy-execution.service.js";
import { CopyFollowerReconciler } from "./copy-follower-monitor.service.js";
import { CopyFollowerScanRepository } from "./copy-follower-scan.repository.js";
import { CopyFollowerSnapshotRepository } from "./copy-follower-snapshot.repository.js";
import { CopyMarketService } from "./copy-market.service.js";
import { CopyPerformanceService } from "./copy-performance.service.js";
import { CopyOrderPlanner } from "./copy-planner.service.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopySignalService } from "./copy-signal.service.js";
import { CopyRepository } from "./copy.repository.js";
import { CopyFollowerLedger } from "./live/copy-follower-ledger.js";
import { HyperliquidFollowerReceiptReader } from "./live/follower-receipt-reader.js";

/**
 * The copy providers that never sign or send anything to an exchange:
 * paper copy (signals, the simulated executor, performance) and the
 * follower reporting (the receipt reconciler, snapshots' repository). The
 * `read` worker's copy loops use these alone (CopyReportingWorkerModule), so
 * it constructs no live engine, setup driver, signer or exchange client.
 * CopyModule imports and re-exports it: one instance per process.
 */
@Module({
  imports: [HyperliquidModule, NotifyModule],
  providers: [CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService, CopyPerformanceService,
    CopyFollowerLedger, CopyFollowerScanRepository, CopyFollowerReconciler, CopyFollowerSnapshotRepository,
    { provide: HyperliquidFollowerReceiptReader, inject: [WALLET_NETWORK_HL], useFactory: ({ budget, transport, network }: WalletNetworkHyperliquid) =>
      // Reporting (the follower monitor's receipts and funding): the shared
      // meter's background lane too, waiting there for room like snapshots.
      new HyperliquidFollowerReceiptReader(network, liveBudget(budget, { lane: "background", maxWaitMs: 5_000 }), transport.fetchEssentialInfo,
        Date.now, weight => { if (weight > 0) budget.adjust(-weight); },
        { acquire: liveBudget(budget, { lane: "background", maxWaitMs: Math.min(180_000, budget.refillMs()) }), maxWaitMs: Math.min(180_000, budget.refillMs()) + 2000 }) },
  ],
  exports: [CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService, CopyPerformanceService,
    CopyFollowerLedger, CopyFollowerScanRepository, CopyFollowerReconciler, CopyFollowerSnapshotRepository, HyperliquidFollowerReceiptReader],
})
export class CopyReadModule {}
