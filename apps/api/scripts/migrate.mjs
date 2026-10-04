import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';

// Explicit release command: never run automatically in every API replica.
// No .env loading and no connection URL/error detail in logs.
const require = createRequire(import.meta.url);
/** Release diagnostics contain only standardized error codes. Drizzle wraps
 * PostgreSQL errors with SQL and parameters, which must never reach logs. */
export function migrationFailureCode(error) {
  const connectionCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT',
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
  const seen = new Set();
  for (let depth = 0; depth < 8 && error && typeof error === 'object' && !seen.has(error); depth++) {
    seen.add(error);
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (typeof code === 'string' && (/^(?:[0-9]{2}|F0|HV|P0|XX)[0-9A-Z]{3}$/.test(code) || connectionCodes.has(code))) return code;
    error = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  }
  return 'unclassified';
}
export async function migrateDatabase(url) {
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 120000 });
  let locked = false;
  await client.connect();
  try {
    const deadline = Date.now() + 60000;
    while (!locked) {
      const result = await client.query('SELECT pg_try_advisory_lock(73104, 2) AS locked');
      locked = result.rows[0].locked;
      if (!locked) {
        if (Date.now() >= deadline) throw new Error('Migration lock timed out');
        await delay(250);
      }
    }
    const sharedEntry = require.resolve('@trading-dashboard/shared/database');
    const migrationsFolder = fileURLToPath(new URL('../drizzle/', pathToFileURL(sharedEntry)));
    const statements = new Map();
    for (const migration of readMigrationFiles({ migrationsFolder })) {
      migration.sql.forEach((statement, index) => statements.set(statement.trim(), `${migration.folderMillis}#${index + 1}`));
    }
    let currentStatement;
    const db = drizzle(client, { logger: { logQuery(query) {
      // Match only trusted, packaged SQL. No provider query/parameters or
      // arbitrary error fields can become a logged statement coordinate.
      const coordinate = statements.get(query.trim());
      if (coordinate) currentStatement = coordinate;
    } } });
    try { await migrate(db, { migrationsFolder }); }
    catch (error) {
      if (currentStatement) console.error(`Migration statement failed [${currentStatement}]`);
      throw error;
    }
    console.log('Database migrations complete');
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(73104, 2)'); }
    finally { await client.end(); }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await migrateDatabase(process.env.DATABASE_URL); }
  catch (error) { console.error(`Database migration failed [${migrationFailureCode(error)}]; verify connectivity, permissions and migration compatibility`); process.exitCode = 1; }
  // The release that carries migration 0021 also moves the stored fills into
  // the typed table: `all` copies in batches, verifies every row and retires
  // the raw table, and does nothing once that is done. A release must not
  // start on a half-converted database, so a failure fails the release.
  if (!process.exitCode) {
    const convert = fileURLToPath(new URL('../dist/traders/convert-history-fills.js', import.meta.url));
    if (existsSync(convert)) {
      const result = spawnSync(process.execPath, [convert, 'all'], { stdio: 'inherit' });
      if (result.status !== 0) { console.error('Stored fill conversion failed'); process.exitCode = 1; }
    }
  }
}
