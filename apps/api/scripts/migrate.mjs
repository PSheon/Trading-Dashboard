import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { createHash } from 'node:crypto';

// Explicit release command: never run automatically in every API replica.
// No .env loading and no connection URL/error detail in logs.
const require = createRequire(import.meta.url);
const CHECK_MIGRATION_TIME = 1790959907204;
const CHECK_MIGRATION_HASH = '18cd2a22973f0977b585070e80d5692e8ff933ff8301916131196a52980d1531';
/** This is a reviewed online execution plan for one immutable migration, not
 * a general SQL rewriter. Original files and journal hashes remain intact. */
export function deferredCheckPlan(migration) {
  if (!migration || migration.folderMillis !== CHECK_MIGRATION_TIME || migration.hash !== CHECK_MIGRATION_HASH ||
    !Array.isArray(migration.sql) || migration.sql.length !== 60 ||
    createHash('sha256').update(migration.sql.join('--> statement-breakpoint')).digest('hex') !== CHECK_MIGRATION_HASH)
    throw new Error('Online constraint migration source mismatch');
  return migration.sql.map((statement, index) => {
    const text = statement.trim();
    const match = /^ALTER TABLE "([a-z][a-z0-9_]{0,62})" ADD CONSTRAINT "([a-z][a-z0-9_]{0,62})" CHECK \([\s\S]+\);$/.exec(text);
    if (!match) throw new Error('Unsupported online constraint statement');
    return Object.freeze({ table: match[1], name: match[2], index: index + 1, sql: text.slice(0, -1) + ' NOT VALID;' });
  });
}
async function applyOnlineCheckPrefix(client, migrations, checks, report) {
  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
  await client.query('CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
  await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__orbie_online_migrations (
    created_at bigint PRIMARY KEY, hash text NOT NULL,
    state text NOT NULL CHECK (state IN ('pending', 'validated')),
    installed_at timestamptz NOT NULL DEFAULT now(), validated_at timestamptz,
    CHECK ((state = 'validated') = (validated_at IS NOT NULL)))`);
  const latest = await client.query('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1');
  const last = Number(latest.rows[0]?.created_at ?? 0);
  const completed = (await client.query('SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = $1', [CHECK_MIGRATION_TIME])).rows;
  const marker = (await client.query('SELECT hash, state FROM drizzle.__orbie_online_migrations WHERE created_at = $1', [CHECK_MIGRATION_TIME])).rows[0];
  const previous = migrations.filter(entry => entry.folderMillis < CHECK_MIGRATION_TIME).at(-1)?.folderMillis;
  if (last >= CHECK_MIGRATION_TIME && (completed.length !== 1 || completed[0].hash !== CHECK_MIGRATION_HASH))
    throw new Error('Completed migration journal mismatch');
  if (marker && (marker.hash !== CHECK_MIGRATION_HASH ||
    (marker.state === 'pending') !== (last < CHECK_MIGRATION_TIME) ||
    (marker.state === 'pending' && (completed.length !== 0 || last !== previous))))
    throw new Error('Online migration journal mismatch');
  if (last >= CHECK_MIGRATION_TIME) return false;
  if (marker) return true;
  // Prefix SQL is exactly the packaged original, except the pinned CHECK
  // additions. The separate pending marker retains new-write enforcement on
  // restart. Do not journal 0026 until validated: older runners must encounter
  // duplicate installed checks and fail, rather than bypass this release gate.
  await client.query('BEGIN');
  try {
    for (const migration of migrations.filter(entry => entry.folderMillis > last && entry.folderMillis <= CHECK_MIGRATION_TIME)) {
      for (let index = 0; index < migration.sql.length; index++) {
        report(`${migration.folderMillis}#${index + 1}`);
        await client.query(migration.folderMillis === CHECK_MIGRATION_TIME ? checks[index].sql : migration.sql[index]);
      }
      if (migration.folderMillis === CHECK_MIGRATION_TIME)
        await client.query("INSERT INTO drizzle.__orbie_online_migrations (hash, created_at, state) VALUES ($1, $2, 'pending')", [migration.hash, migration.folderMillis]);
      else await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [migration.hash, migration.folderMillis]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  return true;
}
async function finalizeOnlineChecks(client) {
  await client.query('BEGIN');
  try {
    const updated = await client.query("UPDATE drizzle.__orbie_online_migrations SET state = 'validated', validated_at = now() WHERE created_at = $1 AND hash = $2 AND state = 'pending'", [CHECK_MIGRATION_TIME, CHECK_MIGRATION_HASH]);
    if (updated.rowCount !== 1) throw new Error('Online migration completion mismatch');
    await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [CHECK_MIGRATION_HASH, CHECK_MIGRATION_TIME]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}
async function validateOnlineChecks(client, checks, report) {
  const result = await client.query(`SELECT r.relname AS table_name, c.conname, c.convalidated
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND c.contype = 'c' AND c.conname = ANY($1::text[])`, [checks.map(check => check.name)]);
  const groups = new Map();
  for (const check of checks) {
    const row = result.rows.find(row => row.table_name === check.table && row.conname === check.name);
    // Later migrations replace some definitions but retain these exact names.
    // A missing installed check is schema drift, never validation success.
    if (!row) throw new Error('Installed migration constraint missing');
    if (row.convalidated) continue;
    const group = groups.get(check.table) ?? []; group.push(check); groups.set(check.table, group);
  }
  if (!groups.size) return;
  await client.query('SET statement_timeout TO 900000');
  try {
    for (const [table, group] of groups) {
      report(`${CHECK_MIGRATION_TIME}#${group[0].index} validate`);
      console.log(`Validating historical checks [${table}]`);
      // One table scan for its checks; SHARE UPDATE EXCLUSIVE permits normal
      // reads/inserts/updates. Identifiers come only from the pinned SQL plan.
      await client.query(`ALTER TABLE "public"."${table}" ${group.map(check => `VALIDATE CONSTRAINT "${check.name}"`).join(', ')}`);
    }
  } finally { await client.query('SET statement_timeout TO 120000').catch(() => undefined); }
}
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
    const migrations = readMigrationFiles({ migrationsFolder });
    const checks = deferredCheckPlan(migrations.find(entry => entry.folderMillis === CHECK_MIGRATION_TIME));
    const statements = new Map();
    for (const migration of migrations) {
      migration.sql.forEach((statement, index) => statements.set(statement.trim(), `${migration.folderMillis}#${index + 1}`));
    }
    let currentStatement;
    const db = drizzle(client, { logger: { logQuery(query) {
      // Match only trusted, packaged SQL. No provider query/parameters or
      // arbitrary error fields can become a logged statement coordinate.
      const coordinate = statements.get(query.trim());
      if (coordinate) currentStatement = coordinate;
    } } });
    try {
      await client.query('SET search_path TO public');
      await client.query('SET lock_timeout TO 15000');
      const report = coordinate => { currentStatement = coordinate; };
      const pending = await applyOnlineCheckPrefix(client, migrations, checks, report);
      await validateOnlineChecks(client, checks, report);
      if (pending) await finalizeOnlineChecks(client);
      await migrate(db, { migrationsFolder });
    }
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
