import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { DATABASE_POOL } from "./drizzle.provider.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";

@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseLifecycle.name);
  private readonly clients = new Set<PoolClient>();
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool, private readonly jobs: BackgroundJobs) {
    pool.on?.("connect", (client) => this.clients.add(client));
    pool.on?.("remove", (client) => this.clients.delete(client));
  }
  async onApplicationShutdown() {
    await this.jobs.drain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // If end() rejects after the deadline wins, that rejection is handled.
    const closed = this.pool.end().then(() => true, () => false);
    try {
      const done = await Promise.race([closed, new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      })]);
      if (!done) {
        this.logger.warn("Pool drain deadline reached; closing remaining connections");
        for (const client of this.clients) void client.end().catch(() => undefined);
      }
    } finally { clearTimeout(timer); }
  }
}
