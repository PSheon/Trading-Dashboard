import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { CopyFollowerMonitor } from "./copy-follower-monitor.service.js";
import { CopyFollowerSnapshotCollector, FOLLOWER_SNAPSHOT_READER } from "./copy-follower-snapshot.service.js";
import { CopyFundingMonitor } from "./copy-funding-monitor.service.js";
import { CopyWorkerService } from "./copy-worker.service.js";
import { CopyModule, WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "./copy.module.js";
import { HyperliquidLiveAccountObserver, observerRestWeight } from "./live/live-account-observer.js";
import { liveReadCache } from "./live/live-read-cache.js";
import { HyperliquidAllDexsAccountSource } from "./live/live-account-ws-source.js";
import { liveBudget } from "../hyperliquid/hyperliquid-budget-wait.js";
import { address, LiveBoundaryError } from './live/wallet-authorization.js';
import { FollowerSnapshotDeferred } from './copy-follower-snapshot.repository.js';
import { CopyLiveSourceRepository } from "./copy-live-source.repository.js";
import { CopyLiveWorkerRepository } from "./live-worker/copy-live-worker.repository.js";
import { CopyLiveStopWorkerRepository } from "./live-worker/copy-live-stop-worker.repository.js";
import { CopyLiveWorkerService } from "./live-worker/copy-live-worker.service.js";
import { LIVE_ENGINE, liveEngineProvider } from "./live-worker/copy-live-engine.provider.js";
import { WatcherRuntimeModule } from "../watcher/watcher-runtime.module.js";
import { CopyReadModule } from "./copy-read.module.js";
import { CopySetupDueListener } from "./live-worker/copy-setup-due.listener.js";
import { liveEvidenceMaxAgeMs } from '../config/live-evidence-window.js';

export function followerSnapshotReader({ budget, transport, network }: Pick<WalletNetworkHyperliquid, 'budget' | 'transport' | 'network'>) {
  // Reporting waits before its evidence clock, under background fairness.
  const waitMs = Math.min(180_000, budget.refillMs());
  const acquire = liveBudget(budget, { lane: 'background', maxWaitMs: waitMs });
  const source = new HyperliquidAllDexsAccountSource(Date.now, undefined, network, transport);
  const shutdown = new AbortController(), cache = liveReadCache(network);
  return {
    async observe(accountAddress: string, beforeRead?: () => Promise<void>) {
      // Decode before charging anything; each read owns its credit.
      const account = address(accountAddress);
      // Only what the cross-order cache lacks: 4 for a warm account instead of 284.
      const paid = observerRestWeight(account, cache);
      await acquire(paid, { signal: shutdown.signal });
      let issued = false, refunded = 0;
      try {
        shutdown.signal.throwIfAborted();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancelled: (() => void) | undefined;
        try {
          // Scheduling has its own pre-clock bound; a late SELECT cannot continue into the observer.
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
          // The cache may have lost a value since: never more than was paid.
          if (consumed || weight > paid) throw new LiveBoundaryError('live_account_invalid_observer');
          shutdown.signal.throwIfAborted();
          consumed = true; // Consume this read's already acquired credit exactly once.
          if (weight < paid) { budget.adjust(weight - paid); refunded = paid - weight; }
        }, (input, init) => {
          shutdown.signal.throwIfAborted();
          issued = true;
          // Background lane: never spends the foreground reserve another process's order needs.
          return transport.fetchBackgroundInfo(input, init);
        }, Date.now, liveEvidenceMaxAgeMs(network), source, waitMs + 2000, cache);
        return await observer.observe(account);
      } finally {
        // Only this phase refunds; once a transport read starts its charge stays.
        if (!issued) budget.adjust(refunded - paid);
      }
    },
    close() { shutdown.abort(new FollowerSnapshotDeferred()); void source.close?.(); },
  };
}

/** The `read` worker's copy loops (paper worker, follower monitor, snapshot collector). They sign
 * and send nothing; paper fills are simulated. */
@Module({
  imports: [CopyReadModule, HyperliquidModule],
  providers: [CopyWorkerService, CopyFollowerMonitor, CopyFollowerSnapshotCollector,
    // Copy-account reads use the wallet network's own budget (copy.module.ts), not
    // the worker's mainnet budget, which the pool and archive loops keep busy.
    { provide: FOLLOWER_SNAPSHOT_READER, inject: [WALLET_NETWORK_HL], useFactory: followerSnapshotReader }],
})
export class CopyReportingWorkerModule {}

/** The `copy` worker's loops: live execution (engine, stops, closes, settlement, setup driver,
 * fast source), funding confirmations and setup wake-ups. */
@Module({
  // WatcherRuntimeModule: the running trade feed (the fast copy source polls while it is down).
  imports: [CopyModule, HyperliquidModule, WatcherRuntimeModule],
  providers: [CopyFundingMonitor, CopyLiveSourceRepository, CopyLiveWorkerRepository, CopyLiveStopWorkerRepository, liveEngineProvider, CopyLiveWorkerService,
    // API_SETUP_DRIVE=worker: the api's confirm and advance wake this worker.
    CopySetupDueListener],
  // LIVE_ENGINE: the heartbeat reports whether this process settles terminal copies (WorkerHeartbeatService).
  exports: [LIVE_ENGINE],
})
export class CopyLiveWorkerModule {}
