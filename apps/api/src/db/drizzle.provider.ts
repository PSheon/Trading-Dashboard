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
export const poolProvider: Provider = {
  provide: DATABASE_POOL,
  inject: [AppConfig],
  useFactory: (config: AppConfig) => guardPool(new Pool({ connectionString: config.value.database.url,
    connectionTimeoutMillis: 3000, statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000, query_timeout: 20000 }), new Logger("DatabasePool")),
};

export const drizzleProvider: Provider = {
  provide: DRIZZLE_CLIENT,
  inject: [DATABASE_POOL],
  useFactory: (pool: Pool): DrizzleDb => drizzle(pool, { schema }),
};
