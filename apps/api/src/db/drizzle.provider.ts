import * as schema from "@trading-dashboard/shared";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Provider } from "@nestjs/common";

import { env } from "../config/env.js";
import { DRIZZLE_CLIENT } from "./db.constants.js";

export type DrizzleDb = NodePgDatabase<typeof schema>;

/** Requires explicit configuration without connecting during provider creation.
 * Compilation never runs this factory and therefore needs no live database. */
export const drizzleProvider: Provider = {
  provide: DRIZZLE_CLIENT,
  useFactory: (): DrizzleDb => {
    const connectionString = env.databaseUrl();
    const pool = new Pool({ connectionString });
    return drizzle(pool, { schema });
  },
};
