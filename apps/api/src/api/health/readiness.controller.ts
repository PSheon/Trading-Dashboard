import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { SkipTransform } from "../../common/decorators/http.decorator.js";
import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { Pool } from "pg";
import { DATABASE_POOL } from "../../db/drizzle.provider.js";
import { BackgroundJobs } from "../../runtime/background-jobs.service.js";
import { Public } from "../../common/auth/public.decorator.js";
import { CachedProbe } from "./cached-probe.js";

@SkipTransform()
@Controller("health")
export class ReadinessController {
  /** At most one database probe per second, however often this is hit:
   * the pool has 10 connections and real requests need them. */
  private readonly probe = new CachedProbe<void>();

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool, private readonly jobs: BackgroundJobs) {}

  @Public()
  @ApiDoc("Ready")
  @Get("ready")
  async ready(): Promise<{ ready: true }> {
    try {
      if (this.jobs.stopping) throw new Error("Stopping");
      const probe = { text: "SELECT 1", query_timeout: 2000 };
      await this.probe.get(async () => { await this.pool.query(probe); });
      if (this.jobs.stopping) throw new Error("Stopping");
      return { ready: true };
    } catch {
      // Operational connection details and credentials never reach the caller.
      throw new ServiceUnavailableException({ ready: false });
    }
  }
}
