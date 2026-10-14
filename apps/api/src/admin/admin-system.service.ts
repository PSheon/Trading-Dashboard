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
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";

@Injectable()
export class AdminSystemService {
  private cached?: { until: number; value: AdminSystemOverview };
  private pending?: Promise<AdminSystemOverview>;
  constructor(private readonly repository: AdminSystemRepository, private readonly config: AppConfig,
    private readonly budgeter: RequestBudgeterService, private readonly fleet: WorkerFleetService,
    @Optional() @Inject(WALLET_NETWORK_HL) private readonly wallet?: Pick<WalletNetworkHyperliquid, "transport">) {}

  overview(): Promise<AdminSystemOverview> {
    if (this.cached && Date.now() < this.cached.until) return Promise.resolve(this.cached.value);
    this.pending ??= this.collect().then(value => {
      this.cached = { until: Date.now() + 5000, value };
      return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async collect(): Promise<AdminSystemOverview> {
    const [database, data, outbox, worker, retention, lanes] = await Promise.allSettled([
      this.repository.probe(), this.repository.data(), this.repository.outbox(), this.fleet.monitors(), this.repository.retention(),
      this.wallet?.transport.laneStatus() ?? Promise.resolve(undefined),
    ]);
    const meter = lanes.status === "fulfilled" ? lanes.value : undefined;
    const lane = (demand: { count: number; held: number; until: number | null }) => ({ ...demand, until: demand.until === null ? null : new Date(demand.until).toISOString() });
    const budget = this.budgeter.introspect(), explorer = explorerHealth.status();
    return {
      sampledAt: new Date().toISOString(),
      api: { state: "active", uptimeSeconds: Math.floor(process.uptime()),
        budget: { ...budget, lastRateLimitedAt: budget.lastRateLimitedAt?.toISOString() ?? null, queued: this.budgeter.queued() },
        switches: operationalSwitches(this.config.value), tuning: this.config.value.tuning,
        // This process's own gauge: the api confirms deposits and returns too.
        explorerReachable: explorer.reachable, explorerFailingSince: explorer.failingSince?.toISOString() ?? null,
        // The shared meter's setup, live and page lanes, as this process reads them.
        ...(meter ? { setupDemand: lane(meter.setupDemand), liveDemand: lane(meter.liveDemand), pageLane: lane(meter.pageLane) } : {}),
        // This process's public IPs (HL_EGRESS_IDENTITY; absent while off).
        ...(egressIdentity.mode === "off" ? {} : { egressIdentity: egressIdentity.snapshot() }),
        // Hyperliquid's rate limits this process met; foreign_usage_suspected among them.
        foreignUsage: foreignUsage.status() },
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
