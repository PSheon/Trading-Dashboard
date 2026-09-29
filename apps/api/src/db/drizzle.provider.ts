import * as schema from "@trading-dashboard/shared/database";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Provider } from "@nestjs/common";

import { env } from "../config/env.js";
import { DRIZZLE_CLIENT } from "./db.constants.js";

export type DrizzleDb = NodePgDatabase<typeof schema>;

/** Requires explicit configuration without connecting during provider creation.
 * Compilation never runs this factory and therefore needs no live database. */
export const DATABASE_POOL = Symbol("DATABASE_POOL");
export const poolProvider: Provider = {
  provide: DATABASE_POOL,
  useFactory: () => new Pool({ connectionString: env.databaseUrl(),
    connectionTimeoutMillis: 3000, statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000, query_timeout: 20000 }),
};

export const drizzleProvider: Provider = {
  provide: DRIZZLE_CLIENT,
  inject: [DATABASE_POOL],
  useFactory: (pool: Pool): DrizzleDb => drizzle(pool, { schema }),
};
