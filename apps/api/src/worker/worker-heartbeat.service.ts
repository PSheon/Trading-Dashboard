import { Inject, Injectable, Optional } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

import { AppConfig } from "../config/app-config.js";
import { DiscoveryPoolService } from "../discovery/discovery-pool.service.js";
import { ArchiveIngestService } from "../ingest/archive-ingest.service.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { WALLET_NETWORK_HL, walletBucket, walletSetupBucket, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";
import { SchedulerService } from "../scheduler/scheduler.service.js";
import { roleLeases } from "../runtime/worker-role.js";
import { WatcherService } from "../watcher/watcher.service.js";
import { clockSkew } from "../copy/live/clock-skew.js";
import { explorerHealth } from "../copy/explorer-health.js";
import { terminalSettlementRuns } from "../copy/live-worker/copy-live-api-settlement.service.js";
import { EgressIdentityMonitor, egressIdentity } from "../runtime/egress-identity.js";
import { foreignUsage } from "../hyperliquid/foreign-usage.js";

/** §8 可觀測: the worker's own heartbeat (feed, snapshots, sweeps, budget,
 * discovery and archive progress), served on its health port and read by
 * the api's `HealthService`. */
@Injectable()
export class WorkerHeartbeatService {
  constructor(
    private readonly config: AppConfig,
    private readonly watcher: WatcherService,
    // Absent on a `copy` worker. The explicit token is required: a union's paramtype is
    // `Object`, so `@Optional()` alone injects nothing (Stage 2026-10-14; test/injection-metadata.spec.ts).
    @Optional() @Inject(SchedulerService) private readonly scheduler: SchedulerService | null,
    private readonly budgeter: RequestBudgeterService,
    @Optional() private readonly archive?: ArchiveIngestService,
    @Optional() private readonly pool?: DiscoveryPoolService,
    @Optional() @Inject(WALLET_NETWORK_HL) private readonly wallet?: WalletNetworkHyperliquid,
    /** The process's egress identity (tests pass their own). */
    @Optional() @Inject(EgressIdentityMonitor) private readonly identity: EgressIdentityMonitor = egressIdentity,
  ) {}

  async heartbeat(): Promise<HeartbeatResponse> {
    const { feed, lastFillAt, lastSweepAt, fillsUnavailable } = this.watcher.getHeartbeat();
    const budget = this.budgeter.introspect(), explorer = explorerHealth.status();
    // The shared meter's setup, live and page lanes (the wallet network's egress); a failed read must not fail the heartbeat.
    const lanes = await this.wallet?.transport.laneStatus().catch(() => undefined);
    const lane = (demand: { count: number; held: number; until: number | null }) => ({ ...demand, until: demand.until === null ? null : new Date(demand.until) });
    return {
      feedConnected: feed.socketsTotal > 0 && feed.socketsOpen === feed.socketsTotal,
      feedSocketsOpen: feed.socketsOpen,
      feedSocketsTotal: feed.socketsTotal,
      marketsSubscribed: feed.markets,
      feedDisconnectedSince: feed.disconnectedSince,
      lastTradeAt: feed.lastTradeAt,
      lastFillAt,
      lastSnapshotAt: this.scheduler?.lastSnapshotAt ?? null,
      lastSnapshotAttemptAt: this.scheduler?.lastSnapshotAttemptAt ?? null,
      lastSnapshotFailureAt: this.scheduler?.lastSnapshotFailureAt ?? null,
      lastSweepAt,
      requestsLastMinute: budget.requestsLastMinute,
      weightLastMinute: budget.weightLastMinute,
      queuedRequests: this.budgeter.queued(),
      budget: {
        effectivePerMin: budget.effectiveBudgetPerMin,
        pageWeightLastMinute: budget.pageWeightLastMinute,
        reserveTokens: Math.round(budget.reserveTokens),
        reserveCapacity: budget.reserveCapacity,
        backgroundFactor: Math.round(budget.backgroundFactor * 100) / 100,
        consumers: budget.consumers,
        caps: budget.consumerCaps,
      },
      // The real-money bucket: who spends it (local testnet, 2026-10-12, where no copy order fitted).
      walletBudget: this.wallet?.dedicated ? walletBucket(this.wallet.network, this.wallet.budget) : undefined,
      // Copy setups' own bucket beside it (c2581938): its tokens and who waits on it.
      setupBudget: this.wallet ? walletSetupBucket(this.wallet) : undefined,
      // Our clock against Hyperliquid's (warns above 1 s; comparisons tolerate 2 s).
      clockSkew: clockSkew.status(),
      // Hyperliquid's explorer, which proves a deposit's credit: reached, or failing since when.
      explorerReachable: explorer.reachable,
      explorerFailingSince: explorer.failingSince,
      setupDemand: lanes ? lane(lanes.setupDemand) : undefined,
      liveDemand: lanes ? lane(lanes.liveDemand) : undefined,
      pageLane: lanes ? lane(lanes.pageLane) : undefined,
      // Age of the boards' and home rows' figures; a failed read must not fail the heartbeat.
      discovery: await this.pool?.freshness().then((f) => ({
        visibleRows: f.visible.rows, medianVisibleAgeSeconds: f.visible.medianAgeSeconds, oldestVisibleAgeSeconds: f.visible.oldestAgeSeconds,
        poolRows: f.pool.rows, poolReady: f.pool.ready, medianPoolAgeSeconds: f.pool.medianAgeSeconds, oldestPoolAgeSeconds: f.pool.oldestAgeSeconds,
      })).catch(() => undefined),
      fillsUnavailable,
      dryRun: this.config.value.telegram.dryRun,
      // Progress of the S3 archive ingest; a failed read must not fail the heartbeat.
      archive: this.archive?.enabled ? await this.archive.status().catch(() => undefined) : undefined,
      // WORKER_ROLE and its leases; terminalSettlement is what the api's guard checks while
      // API_TERMINAL_SETTLEMENT=off (WorkerFleetService).
      worker: { role: this.config.value.app.workerRole, leases: [...roleLeases(this.config.value.app.workerRole)], terminalSettlement: terminalSettlementRuns(this.config) },
      // Public IPs (HL_EGRESS_IDENTITY), compared across processes by WorkerFleetService.
      egressIdentity: this.identity.mode === "off" ? undefined : this.identity.snapshot(),
      // Hyperliquid's rate limits met here, and those while our own meter
      // held under 80 % of the window (foreign_usage_suspected).
      foreignUsage: foreignUsage.status(),
      now: new Date(),
    };
  }
}
