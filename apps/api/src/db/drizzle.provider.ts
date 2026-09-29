import * as schema from "@trading-dashboard/shared";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Provider } from "@nestjs/common";

import { env } from "../config/env.js";
import { DRIZZLE_CLIENT } from "./db.constants.js";

export type DrizzleDb = NodePgDatabase<typeof schema>;

/**
 * Drizzle connection provider, reading DATABASE_URL from env (§7/§11).
 *
 * The pool is created lazily and lets pg's own connection handling manage
 * reconnects. Nothing here requires a live Postgres to exist at process
 * startup (the pool connects on first query), which is what lets `pnpm
 * typecheck`/`pnpm build` succeed without a running database.
 */
export const drizzleProvider: Provider = {
  provide: DRIZZLE_CLIENT,
  useFactory: (): DrizzleDb => {
    const connectionString = env.databaseUrl();
    if (!connectionString) {
      // eslint-disable-next-line no-console
      console.warn(
        "[db] DATABASE_URL is not set — queries will fail until it is configured.",
      );
    }
    const pool = new Pool({
      connectionString: connectionString ?? "postgres://localhost:5432/postgres",
    });
    return drizzle(pool, { schema });
  },
};
