import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
const { drizzle } = require("drizzle-orm/node-postgres");
const { migrate } = require("drizzle-orm/node-postgres/migrator");

export function validateTestAdminUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("TEST_DATABASE_ADMIN_URL must be an explicit local PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/^\/(?:postgres|[a-zA-Z0-9_]+_test)$/.test(url.pathname) || url.search || url.hash) {
    throw new Error("Test database administrator must use loopback, postgres or an _test database, without URL options");
  }
  return url;
}

/** Creates only a random owned database; never migrates/truncates the parent.
 * The caller owns its processes/pools and must close them before returning. */
export async function withTestDatabase(work) {
  const adminUrl = validateTestAdminUrl(process.env.TEST_DATABASE_ADMIN_URL ?? process.env.TEST_DATABASE_URL);
  const name = `orbie_${randomUUID().replaceAll("-", "")}_test`;
  const runUrl = new URL(adminUrl); runUrl.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 3000 });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const pool = new Pool({ connectionString: runUrl.toString(), max: 1, connectionTimeoutMillis: 3000 });
    try { await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../packages/shared/drizzle", import.meta.url)) }); }
    finally { await pool.end(); }
    console.log(`Isolated test database ready: ${name}`);
    return await work(runUrl.toString(), name);
  } finally {
    try {
      if (created) {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        console.log(`Isolated test database removed: ${name}`);
      }
    } finally { await admin.end(); }
  }
}
