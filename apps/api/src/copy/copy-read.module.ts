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
import { LIVE_READ_WAIT_MS } from "../config/constants/hyperliquid.js";

/** Copy providers that never sign or send: paper copy and follower reporting. The `read` worker
 * uses only these (no engine, signer or exchange client); CopyModule re-exports it. */
@Module({
  imports: [HyperliquidModule, NotifyModule],
  providers: [CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService, CopyPerformanceService,
    CopyFollowerLedger, CopyFollowerScanRepository, CopyFollowerReconciler, CopyFollowerSnapshotRepository,
    { provide: HyperliquidFollowerReceiptReader, inject: [WALLET_NETWORK_HL], useFactory: ({ budget, transport, network }: WalletNetworkHyperliquid) =>
      // Reporting reads use the background lane, like snapshots.
      new HyperliquidFollowerReceiptReader(network, liveBudget(budget, { lane: "background", maxWaitMs: LIVE_READ_WAIT_MS }), transport.fetchEssentialInfo,
        Date.now, weight => { if (weight > 0) budget.adjust(-weight); },
        { acquire: liveBudget(budget, { lane: "background", maxWaitMs: Math.min(180_000, budget.refillMs()) }), maxWaitMs: Math.min(180_000, budget.refillMs()) + 2000 }) },
  ],
  exports: [CopyRepository, CopyMarketService, CopyRiskPolicyService, CopyOrderPlanner, CopySignalService, CopyExecutionService, CopyPerformanceService,
    CopyFollowerLedger, CopyFollowerScanRepository, CopyFollowerReconciler, CopyFollowerSnapshotRepository, HyperliquidFollowerReceiptReader],
})
export class CopyReadModule {}
