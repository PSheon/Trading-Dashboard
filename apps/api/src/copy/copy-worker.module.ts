import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { CopyFollowerMonitor } from "./copy-follower-monitor.service.js";
import { CopyFollowerSnapshotCollector, FOLLOWER_SNAPSHOT_READER } from "./copy-follower-snapshot.service.js";
import { CopyFundingMonitor } from "./copy-funding-monitor.service.js";
import { CopyWorkerService } from "./copy-worker.service.js";
import { CopyModule, WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "./copy.module.js";
import { HyperliquidLiveAccountObserver } from "./live/live-account-observer.js";
import { HyperliquidAllDexsAccountSource } from "./live/live-account-ws-source.js";
import { liveBudget } from "../hyperliquid/hyperliquid-budget-wait.js";
import { CopyLiveSourceRepository } from "./copy-live-source.repository.js";
import { CopyLiveWorkerRepository } from "./live-worker/copy-live-worker.repository.js";
import { CopyLiveStopWorkerRepository } from "./live-worker/copy-live-stop-worker.repository.js";
import { CopyLiveWorkerService } from "./live-worker/copy-live-worker.service.js";
import { liveEngineProvider } from "./live-worker/copy-live-engine.provider.js";
import { WatcherModule } from "../watcher/watcher.module.js";

/** The copy loops: the paper copy worker, testnet copy execution (only with
 * COPY_TRADING_MODE=testnet), strategy funding confirmations, the
 * follower receipt monitor and the follower snapshot collector. Imported by
 * the worker process only (AppModule.worker()); the api never constructs them. */
@Module({
  // WatcherModule: the trade feed's state (the fast copy source polls while it is down).
  imports: [CopyModule, HyperliquidModule, WatcherModule],
  providers: [CopyWorkerService, CopyFundingMonitor, CopyFollowerMonitor, CopyFollowerSnapshotCollector,
    CopyLiveSourceRepository, CopyLiveWorkerRepository, CopyLiveStopWorkerRepository, liveEngineProvider, CopyLiveWorkerService,
    // Testnet reads use the wallet network's own budget (copy.module.ts), not
    // the worker's mainnet budget, which the pool and archive loops keep busy.
    { provide: FOLLOWER_SNAPSHOT_READER, inject: [WALLET_NETWORK_HL], useFactory: ({ budget, transport }: WalletNetworkHyperliquid) =>
      new HyperliquidLiveAccountObserver('testnet', liveBudget(budget, { lane: 'background', maxWaitMs: 5000 }), transport.fetchInfo, Date.now, 5000,
        new HyperliquidAllDexsAccountSource(Date.now, undefined, 'testnet', transport)) }],
})
export class CopyWorkerModule {}
