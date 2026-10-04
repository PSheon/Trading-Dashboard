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

/** pg-pool resolves `end()` once its clients are detached, not once the
 * server has seen them go: each client's Terminate can still be in flight. A
 * FORCE drop in that window signals the backend, which answers the departing
 * client with FATAL 57P01, and pg-pool re-emits that on the already-ended pool
 * as an unhandled 'error' that kills the caller. Wait (bounded) until the
 * database has no backends left; FORCE then only reaches a connection the
 * caller genuinely left open, which is a real leak and stays loud. */
async function waitForDisconnect(admin, name, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query("SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
    if (rows[0].open === 0) return;
    if (Date.now() >= deadline) {
      console.warn(`Isolated test database ${name} still has ${rows[0].open} connection(s) open; dropping with FORCE`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
        await waitForDisconnect(admin, name);
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        console.log(`Isolated test database removed: ${name}`);
      }
    } finally { await admin.end(); }
  }
}
