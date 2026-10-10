import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { CopyFollowerMonitor } from "./copy-follower-monitor.service.js";
import { CopyFollowerSnapshotCollector, FOLLOWER_SNAPSHOT_READER } from "./copy-follower-snapshot.service.js";
import { CopyFundingMonitor } from "./copy-funding-monitor.service.js";
import { CopyWorkerService } from "./copy-worker.service.js";
import { CopyModule, WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "./copy.module.js";
import { HyperliquidLiveAccountObserver, OBSERVER_REST_WEIGHT } from "./live/live-account-observer.js";
import { HyperliquidAllDexsAccountSource } from "./live/live-account-ws-source.js";
import { liveBudget } from "../hyperliquid/hyperliquid-budget-wait.js";
import { address, LiveBoundaryError } from './live/wallet-authorization.js';
import { FollowerSnapshotDeferred } from './copy-follower-snapshot.repository.js';
import { CopyLiveSourceRepository } from "./copy-live-source.repository.js";
import { CopyLiveWorkerRepository } from "./live-worker/copy-live-worker.repository.js";
import { CopyLiveStopWorkerRepository } from "./live-worker/copy-live-stop-worker.repository.js";
import { CopyLiveWorkerService } from "./live-worker/copy-live-worker.service.js";
import { liveEngineProvider } from "./live-worker/copy-live-engine.provider.js";
import { WatcherModule } from "../watcher/watcher.module.js";

export function followerSnapshotReader({ budget, transport, network }: Pick<WalletNetworkHyperliquid, 'budget' | 'transport' | 'network'>) {
  // Reporting waits before its evidence clock, under the existing background
  // fairness policy. Collector admission still permits one claim per minute.
  const waitMs = Math.min(180_000, budget.refillMs());
  const acquire = liveBudget(budget, { lane: 'background', maxWaitMs: waitMs });
  const source = new HyperliquidAllDexsAccountSource(Date.now, undefined, network, transport);
  const shutdown = new AbortController();
  return {
    async observe(accountAddress: string, beforeRead?: () => Promise<void>) {
      // Keep the original decoder before charging anything. Each read owns
      // its credit; neither SQL nor a late continuation owns a provider call.
      const account = address(accountAddress);
      await acquire(OBSERVER_REST_WEIGHT, { signal: shutdown.signal });
      let issued = false;
      try {
        shutdown.signal.throwIfAborted();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancelled: (() => void) | undefined;
        try {
          // Scheduling has its own pre-clock bound, separate from the local
          // reserve. Late SELECT completion cannot continue into the observer.
          await Promise.race([
            Promise.resolve().then(() => beforeRead?.()),
            new Promise<never>((_, reject) => {
              cancelled = () => reject(new FollowerSnapshotDeferred());
              timer = setTimeout(cancelled, 2000);
              shutdown.signal.addEventListener('abort', cancelled, { once: true });
            }),
          ]);
        } finally {
          clearTimeout(timer);
          if (cancelled) shutdown.signal.removeEventListener('abort', cancelled);
        }
        shutdown.signal.throwIfAborted();
        let consumed = false;
        const observer = new HyperliquidLiveAccountObserver(network, async weight => {
          if (consumed || weight !== OBSERVER_REST_WEIGHT) throw new LiveBoundaryError('live_account_invalid_observer');
          shutdown.signal.throwIfAborted();
          consumed = true; // Consume this read's already acquired credit exactly once.
        }, (input, init) => {
          shutdown.signal.throwIfAborted();
          issued = true;
          // Scheduled reporting must honor both the local background queue
          // and the shared background cap; it cannot spend the foreground
          // reserve needed by an order in another process.
          return transport.fetchBackgroundInfo(input, init);
        }, Date.now, 5000, source, waitMs + 2000);
        return await observer.observe(account);
      } finally {
        // Only this outer phase refunds. A failed/late SQL check and close
        // have issued nothing; once a transport read starts its charge stays.
        if (!issued) budget.adjust(-OBSERVER_REST_WEIGHT);
      }
    },
    close() { shutdown.abort(new FollowerSnapshotDeferred()); void source.close?.(); },
  };
}

/** The copy loops: the paper copy worker, testnet copy execution (only with
 * COPY_TRADING_MODE=testnet), strategy funding confirmations, the
 * follower receipt monitor and the follower snapshot collector. Imported by
 * the worker process only (AppModule.worker()); the api never constructs them. */
@Module({
  // WatcherModule: the trade feed's state (the fast copy source polls while it is down).
  imports: [CopyModule, HyperliquidModule, WatcherModule],
  providers: [CopyWorkerService, CopyFundingMonitor, CopyFollowerMonitor, CopyFollowerSnapshotCollector,
    CopyLiveSourceRepository, CopyLiveWorkerRepository, CopyLiveStopWorkerRepository, liveEngineProvider, CopyLiveWorkerService,
    // Copy-account reads use the wallet network's own budget (copy.module.ts), not
    // the worker's mainnet budget, which the pool and archive loops keep busy.
    { provide: FOLLOWER_SNAPSHOT_READER, inject: [WALLET_NETWORK_HL], useFactory: followerSnapshotReader }],
})
export class CopyWorkerModule {}
