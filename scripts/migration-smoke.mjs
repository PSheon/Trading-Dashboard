import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { withTestDatabase } from './test-database.mjs';
import { migrateDatabase } from '../apps/api/scripts/migrate.mjs';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
await withTestDatabase(async (url) => {
  const pool = new Pool({ connectionString: url });
  try {
    const before = await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
    await Promise.all([migrateDatabase(url), migrateDatabase(url)]);
    const after = await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
    assert.equal(after.rows[0].count, before.rows[0].count);
    // Readiness only probes connectivity: independently verify the archive
    // schema needed by the new worker and analytics queries.
    await pool.query('SELECT account_id, twap, tid, time, origin, px, sz, hash, extra FROM history_fills LIMIT 0');
    await pool.query('SELECT id, chain, address FROM history_accounts LIMIT 0');
    await pool.query('SELECT id, term FROM history_terms LIMIT 0');
    await pool.query('SELECT checkpoint, version, status, published_through, attempted_at, last_error FROM analysis_history_jobs LIMIT 0');
    await pool.query('SELECT history_through FROM trader_analytics LIMIT 0');
    await pool.query('SELECT id, status, version, lease_token, lease_expires_at, run_attempts FROM backfill_jobs LIMIT 0');
    await pool.query('SELECT id, user_id, name, color, sort_order FROM favorite_groups LIMIT 0');
    await pool.query('SELECT user_id, group_id, chain, address FROM favorite_group_members LIMIT 0');
    await pool.query('SELECT id, user_id, account_id, strategy_id, network, amount, nonce, status, attempted_at, transaction_hash, credited_amount, fee, scan_state, scan_revision FROM copy_funding_operations LIMIT 0');
    console.log('Persistent history schema is queryable after release migrations');
    console.log('Concurrent release migrations are repeatable');
    // This database is disposable. Retain the already-applied schema but
    // remove one journal tail to reproduce a real migration/schema conflict.
    const entries = JSON.parse(readFileSync(new URL('../packages/shared/drizzle/meta/_journal.json', import.meta.url), 'utf8')).entries;
    const replay = entries.find(entry => entry.tag === '0052_retain_provider_cleanup_evidence');
    assert.ok(replay);
    await pool.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= $1', [replay.when]);
    const failed = spawnSync(process.execPath, ['apps/api/scripts/migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(failed.status, 1, 'A genuine schema conflict must fail the release');
    assert.ok(failed.stderr.includes('[42701]'), 'Wrapped PostgreSQL duplicate-column code must be visible');
    assert.ok(failed.stderr.includes(`[${replay.when}#1]`), 'The known release statement must be identifiable');
    for (const forbidden of [url, 'ALTER TABLE', 'Failed query:', 'password'])
      assert.equal(failed.stderr.includes(forbidden), false, 'Diagnostics must not print SQL or connection details');
    console.log('Real migration conflict exposes only safe code and statement coordinates');
  } finally { await pool.end(); }
});
