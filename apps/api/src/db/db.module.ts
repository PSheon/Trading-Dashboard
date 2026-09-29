import { UnitOfWork } from "./unit-of-work.js";
import { Global, Module } from "@nestjs/common";

import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { DatabaseLifecycle } from "./database-lifecycle.service.js";
import { drizzleProvider, poolProvider } from "./drizzle.provider.js";

/**
 * Global module exposing the single Drizzle client (DRIZZLE_CLIENT token)
 * to every feature module, per the "one Postgres, one process" decision
 * (§3 principle 6 / §7).
 */
@Global()
@Module({
  providers: [UnitOfWork, poolProvider, drizzleProvider, BackgroundJobs, DatabaseLifecycle],
  exports: [UnitOfWork, drizzleProvider, poolProvider, BackgroundJobs],
})
export class DbModule {}
