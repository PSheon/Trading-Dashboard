import type { FactoryProvider } from "@nestjs/common";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config/app-config.js";
import { DATABASE_POOL_MAX_API, DATABASE_POOL_MAX_COPY_WORKER, DATABASE_POOL_MAX_READ_WORKER, DATABASE_POOL_MAX_WORKER } from "../src/config/constants/database.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
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
  it("is sized per process and worker role by default: api 10, copy worker 20, read worker 10, one worker of both 30", async () => {
    expect([DATABASE_POOL_MAX_API, DATABASE_POOL_MAX_COPY_WORKER, DATABASE_POOL_MAX_READ_WORKER, DATABASE_POOL_MAX_WORKER]).toEqual([10, 20, 10, 30]);
    expect(validateEnvironment({ DATABASE_URL: url }).database.poolMax).toBe(10);
    expect(validateEnvironment({ DATABASE_URL: url, IS_WORKER: "true", WORKER_ROLE: "copy" }).database.poolMax).toBe(20);
    expect(validateEnvironment({ DATABASE_URL: url, IS_WORKER: "true", WORKER_ROLE: "read" }).database.poolMax).toBe(10);
    expect(validateEnvironment({ DATABASE_URL: url, IS_WORKER: "true" }).database.poolMax).toBe(30);
    expect(validateEnvironment({ DATABASE_URL: url, IS_WORKER: "true", WORKER_ROLE: "all" }).database.poolMax).toBe(30);
    const pool = await poolFor({});
    try {
      expect(pool.options.max).toBe(10);
    } finally {
      await pool.end();
    }
  });

  it("Stage's processes fit Postgres's 97 usable connections with room to spare, even while the api is redeployed", () => {
    // api + copy worker + read worker, and each worker's lease connection (its own pool of one).
    const steady = DATABASE_POOL_MAX_API + DATABASE_POOL_MAX_COPY_WORKER + DATABASE_POOL_MAX_READ_WORKER + 2;
    // Rolling api deploy: the old and the new api at once, and the pre-deploy migration.
    // A worker's replacement holds only its lease until the old one exits (it builds nothing before).
    const apiDeploy = steady + DATABASE_POOL_MAX_API + 1;
    const everythingAtOnce = apiDeploy + 2;
    expect([steady, apiDeploy, everythingAtOnce]).toEqual([42, 53, 55]);
    // Was 82 steady and ~103 during an api deploy (over the limit).
    expect(everythingAtOnce).toBeLessThanOrEqual(97 - 30);
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
