import type { FactoryProvider } from "@nestjs/common";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config/app-config.js";
import { DATABASE_POOL_MAX_API, DATABASE_POOL_MAX_WORKER, validateEnvironment } from "../src/config/runtime-config.js";
import { poolProvider } from "../src/db/drizzle.provider.js";

/** pg's default pool of 10 was shared by the relays, every live order's two
 * dedicated connections, the snapshot cron, sweeps, analytics and retention:
 * when it ran out an order waited 3 s for a connection inside its 5 s window. */
const url = "postgres://test@localhost/test";
async function poolFor(env: Record<string, string>): Promise<Pool> {
  const config = new AppConfig(validateEnvironment({ DATABASE_URL: url, ...env }));
  return (poolProvider as FactoryProvider<Pool>).useFactory(config) as Pool;
}

describe("the main database pool's size", () => {
  it("is sized per process by default: api 20, worker 30", async () => {
    expect(DATABASE_POOL_MAX_API).toBe(20);
    expect(DATABASE_POOL_MAX_WORKER).toBe(30);
    expect(validateEnvironment({ DATABASE_URL: url }).database.poolMax).toBe(20);
    expect(validateEnvironment({ DATABASE_URL: url, IS_WORKER: "true" }).database.poolMax).toBe(30);
    const pool = await poolFor({});
    try {
      expect(pool.options.max).toBe(20);
    } finally {
      await pool.end();
    }
  });

  it("DATABASE_POOL_MAX sets it, within 2–200", async () => {
    expect(validateEnvironment({ DATABASE_URL: url, DATABASE_POOL_MAX: "12" }).database.poolMax).toBe(12);
    expect(validateEnvironment({ DATABASE_URL: url, IS_WORKER: "true", DATABASE_POOL_MAX: "40" }).database.poolMax).toBe(40);
    const pool = await poolFor({ DATABASE_POOL_MAX: "7" });
    try {
      expect(pool.options.max).toBe(7);
    } finally {
      await pool.end();
    }
    for (const bad of ["1", "201", "ten", "-5"]) {
      expect(() => validateEnvironment({ DATABASE_URL: url, DATABASE_POOL_MAX: bad })).toThrow("DATABASE_POOL_MAX must be an integer between 2 and 200");
    }
  });
});
