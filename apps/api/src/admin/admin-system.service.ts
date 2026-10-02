import { Injectable } from "@nestjs/common";
import { adminSystemSchema, workerMonitorSchema, type AdminSystemOverview } from "@trading-dashboard/shared/contracts";
import { AppConfig } from "../config/app-config.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { operationalSwitches } from "../runtime/operational-switches.js";
import { AdminSystemRepository } from "./admin-system.repository.js";

@Injectable()
export class AdminSystemService {
  private cached?: { until: number; value: AdminSystemOverview };
  private pending?: Promise<AdminSystemOverview>;
  constructor(private readonly repository: AdminSystemRepository, private readonly config: AppConfig,
    private readonly budgeter: RequestBudgeterService) {}

  overview(): Promise<AdminSystemOverview> {
    if (this.cached && Date.now() < this.cached.until) return Promise.resolve(this.cached.value);
    this.pending ??= this.collect().then(value => {
      this.cached = { until: Date.now() + 5000, value };
      return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async worker(): Promise<AdminSystemOverview["worker"]> {
    if (!this.config.value.app.workerUrl) return { state: "not_configured", sample: null };
    try {
      const response = await fetch(new URL("/health/monitor", this.config.value.app.workerUrl), { signal: AbortSignal.timeout(3000), cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const sample = workerMonitorSchema.parse(await response.json());
      const age = Date.now() - Date.parse(sample.sampledAt);
      return { state: age > 30_000 || age < -5000 ? "stale" : sample.state, sample };
    } catch { return { state: "unavailable", sample: null }; }
  }

  private async collect(): Promise<AdminSystemOverview> {
    const [database, data, outbox, worker] = await Promise.allSettled([
      this.repository.probe(), this.repository.data(), this.repository.outbox(), this.worker(),
    ]);
    const budget = this.budgeter.introspect();
    return {
      sampledAt: new Date().toISOString(),
      api: { state: "active", role: adminSystemSchema.shape.api.shape.role.parse(this.config.value.app.role), uptimeSeconds: Math.floor(process.uptime()),
        budget: { ...budget, lastRateLimitedAt: budget.lastRateLimitedAt?.toISOString() ?? null, queued: this.budgeter.queued() },
        switches: operationalSwitches(this.config.value) },
      worker: worker.status === "fulfilled" ? worker.value : { state: "unavailable", sample: null },
      database: database.status === "fulfilled" ? { state: "available", latencyMs: database.value } : { state: "unavailable", latencyMs: null },
      data: data.status === "fulfilled" ? data.value : null,
      outbox: outbox.status === "fulfilled" ? outbox.value : null,
    };
  }
}
