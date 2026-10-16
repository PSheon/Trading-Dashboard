import * as schema from "@trading-dashboard/shared/database";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Logger, type Provider } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { DRIZZLE_CLIENT } from "./db.constants.js";
import { guardPool } from "../bootstrap/process-guards.js";

export type DrizzleDb = NodePgDatabase<typeof schema>;

/** Requires explicit configuration without connecting during provider creation.
 * Compilation never runs this factory and therefore needs no live database. */
export const DATABASE_POOL = Symbol("DATABASE_POOL");
/** The pool's application_name (pg_stat_activity, a live_risk_busy's holder):
 * `td-api`, or `td-worker-<role>` (all, copy, read). */
export function databaseApplicationName(config: AppConfig): string {
  const app = config.value.app;
  return app.isWorker ? `td-worker-${app.workerRole}` : "td-api";
}
export const poolProvider: Provider = {
  provide: DATABASE_POOL,
  inject: [AppConfig],
  useFactory: (config: AppConfig) => guardPool(new Pool({ connectionString: config.value.database.url,
    max: config.value.database.poolMax, connectionTimeoutMillis: 3000, statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000, query_timeout: 20000, application_name: databaseApplicationName(config) }), new Logger("DatabasePool")),
};

export const drizzleProvider: Provider = {
  provide: DRIZZLE_CLIENT,
  inject: [DATABASE_POOL],
  useFactory: (pool: Pool): DrizzleDb => drizzle(pool, { schema }),
};
