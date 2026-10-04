import { Module } from "@nestjs/common";

import { HyperliquidGlobalTransport } from "../hyperliquid/hyperliquid-global-transport.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { CopyFollowerMonitor } from "./copy-follower-monitor.service.js";
import { CopyFollowerSnapshotCollector, FOLLOWER_SNAPSHOT_READER } from "./copy-follower-snapshot.service.js";
import { CopyFundingMonitor } from "./copy-funding-monitor.service.js";
import { CopyWorkerService } from "./copy-worker.service.js";
import { CopyModule } from "./copy.module.js";
import { HyperliquidLiveAccountObserver } from "./live/live-account-observer.js";
import { HyperliquidAllDexsAccountSource } from "./live/live-account-ws-source.js";
import { CopyLiveSourceRepository } from "./copy-live-source.repository.js";
import { CopyLiveWorkerRepository } from "./live-worker/copy-live-worker.repository.js";
import { CopyLiveStopWorkerRepository } from "./live-worker/copy-live-stop-worker.repository.js";
import { CopyLiveWorkerService } from "./live-worker/copy-live-worker.service.js";
import { liveEngineProvider } from "./live-worker/copy-live-engine.provider.js";

/** The copy loops: the paper copy worker, testnet copy execution (only with
 * COPY_TRADING_MODE=testnet), strategy funding confirmations, the
 * follower receipt monitor and the follower snapshot collector. Imported by
 * the worker process only (AppModule.worker()); the api never constructs them. */
@Module({
  imports: [CopyModule, HyperliquidModule],
  providers: [CopyWorkerService, CopyFundingMonitor, CopyFollowerMonitor, CopyFollowerSnapshotCollector,
    CopyLiveSourceRepository, CopyLiveWorkerRepository, CopyLiveStopWorkerRepository, liveEngineProvider, CopyLiveWorkerService,
    { provide: FOLLOWER_SNAPSHOT_READER, inject: [RequestBudgeterService, HyperliquidGlobalTransport], useFactory: (budget: RequestBudgeterService, transport: HyperliquidGlobalTransport) =>
      new HyperliquidLiveAccountObserver('testnet', weight => budget.acquire(weight, 'background', undefined, { signal: AbortSignal.timeout(5000) }), transport.fetchInfo, Date.now, 5000,
        new HyperliquidAllDexsAccountSource(Date.now, undefined, 'testnet', transport)) }],
})
export class CopyWorkerModule {}
