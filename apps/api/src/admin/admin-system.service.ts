import { Inject, Injectable, Optional } from "@nestjs/common";
import type { AdminSystemOverview } from "@trading-dashboard/shared/contracts";
import { AppConfig } from "../config/app-config.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { operationalSwitches } from "../runtime/operational-switches.js";
import { WorkerFleetService } from "../api/health/worker-fleet.service.js";
import { AdminSystemRepository } from "./admin-system.repository.js";
import { explorerHealth } from "../copy/explorer-health.js";
import { egressIdentity } from "../runtime/egress-identity.js";
import { foreignUsage } from "../hyperliquid/foreign-usage.js";
import { WALLET_NETWORK_HL, walletSetupBucket, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";
import { PostgresHyperliquidQuota } from "../hyperliquid/postgres-hyperliquid-quota.js";
import { readMeterKey } from "../hyperliquid/hyperliquid-meter-key.js";
import { HYPERLIQUID_REST_CAP, READ_WORKER_BACKGROUND_REST_CAP } from "../config/constants/hyperliquid.js";

@Injectable()
export class AdminSystemService {
  private cached?: { until: number; value: AdminSystemOverview };
  private pending?: Promise<AdminSystemOverview>;
  constructor(private readonly repository: AdminSystemRepository, private readonly config: AppConfig,
    private readonly budgeter: RequestBudgeterService, private readonly fleet: WorkerFleetService,
    @Optional() @Inject(WALLET_NETWORK_HL) private readonly wallet?: Pick<WalletNetworkHyperliquid, "transport"> & Partial<Pick<WalletNetworkHyperliquid, "network" | "budget" | "setupBudget" | "dedicated">>,
    /** The meter rows (D12: both meters are shown); reads only, never a charge. */
    @Optional() @Inject(PostgresHyperliquidQuota) private readonly quota?: Pick<PostgresHyperliquidQuota, "meterSnapshot">) {}

  /** Both Hyperliquid meters (D12): the copy side's shared one (this api's,
   * with its own background cap) and the read worker's (`<key>:read`, at
   * READ_WORKER_BACKGROUND_REST_CAP), each as its row stands. Undefined
   * without an egress key or a quota; a failed read leaves the meter out. */
  private async meters(): Promise<AdminSystemOverview["api"]["meters"]> {
    const { sharedEgressKey, backgroundRestCap } = this.config.value.hyperliquid;
    if (!sharedEgressKey || !this.quota) return undefined;
    const wanted = [{ meter: "copy" as const, egressKey: sharedEgressKey, backgroundCap: backgroundRestCap }, { meter: "read" as const, egressKey: readMeterKey(sharedEgressKey), backgroundCap: READ_WORKER_BACKGROUND_REST_CAP }];
    const read = await Promise.allSettled(wanted.map(m => this.quota!.meterSnapshot(m.egressKey)));
    return wanted.flatMap((m, i) => {
      const snapshot = read[i];
      if (snapshot?.status !== "fulfilled") return [];
      const rest = snapshot.value.rest, setup = Object.values(rest.setup).reduce((sum, units) => sum + units, 0), markers = rest.markers.setup + rest.markers.live + rest.markers.source;
      return [{ ...m, reserved: HYPERLIQUID_REST_CAP - m.backgroundCap,
        rest: { total: rest.total, background: rest.background, page: rest.page, live: rest.live, source: rest.source, setup, other: rest.other, markers } }];
    });
  }

  overview(): Promise<AdminSystemOverview> {
    if (this.cached && Date.now() < this.cached.until) return Promise.resolve(this.cached.value);
    this.pending ??= this.collect().then(value => {
      this.cached = { until: Date.now() + 5000, value };
      return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async collect(): Promise<AdminSystemOverview> {
    const [database, data, outbox, worker, retention, lanes, meters] = await Promise.allSettled([
      this.repository.probe(), this.repository.data(), this.repository.outbox(), this.fleet.monitors(), this.repository.retention(),
      this.wallet?.transport.laneStatus() ?? Promise.resolve(undefined), this.meters(),
    ]);
    const meter = lanes.status === "fulfilled" ? lanes.value : undefined;
    const lane = (demand: { count: number; held: number; until: number | null }) => ({ ...demand, until: demand.until === null ? null : new Date(demand.until).toISOString() });
    const budget = this.budgeter.introspect(), explorer = explorerHealth.status(), w = this.wallet;
    const setup = w?.network && w.budget && w.setupBudget && w.dedicated ? walletSetupBucket({ network: w.network, budget: w.budget, setupBudget: w.setupBudget, dedicated: w.dedicated }) : undefined;
    return {
      sampledAt: new Date().toISOString(),
      api: { state: "active", uptimeSeconds: Math.floor(process.uptime()),
        budget: { ...budget, lastRateLimitedAt: budget.lastRateLimitedAt?.toISOString() ?? null, queued: this.budgeter.queued() },
        switches: operationalSwitches(this.config.value), tuning: this.config.value.tuning,
        // This process's own gauge: the api confirms deposits and returns too.
        explorerReachable: explorer.reachable, explorerFailingSince: explorer.failingSince?.toISOString() ?? null,
        // The shared meter's setup, live and page lanes, as this process reads them.
        ...(meter ? { setupDemand: lane(meter.setupDemand), liveDemand: lane(meter.liveDemand), pageLane: lane(meter.pageLane), sourceLane: lane(meter.sourceLane) } : {}),
        // Both meters' rows (D12): the copy side's shared one and the read worker's own.
        ...(meters.status === "fulfilled" && meters.value ? { meters: meters.value } : {}),
        // This process's public IPs (HL_EGRESS_IDENTITY; absent while off).
        ...(egressIdentity.mode === "off" ? {} : { egressIdentity: egressIdentity.snapshot() }),
        // Hyperliquid's rate limits this process met; foreign_usage_suspected among them.
        foreignUsage: foreignUsage.status(),
        // This process's copy-setup bucket, when it has its own (setups the api drives: API_SETUP_DRIVE=local).
        ...(setup ? { setupBudget: setup } : {}) },
      worker: worker.status === "fulfilled" ? worker.value.worker : { state: "unavailable", sample: null },
      ...(worker.status === "fulfilled" && worker.value.read ? { workerRead: worker.value.read } : {}),
      database: database.status === "fulfilled" ? { state: "available", latencyMs: database.value } : { state: "unavailable", latencyMs: null },
      data: data.status === "fulfilled" ? data.value : null,
      outbox: outbox.status === "fulfilled" ? outbox.value : null,
      retention: retention.status === "fulfilled" ? retention.value : null,
      // After the worker read above: what the api's worker guards see now.
      alerts: this.fleet.alerts(),
    };
  }
}
