import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
    await pool.query('SELECT chain, address, source, tid, time, raw FROM analysis_history_fills LIMIT 0');
    await pool.query('SELECT checkpoint, version, status, published_through, attempted_at, last_error FROM analysis_history_jobs LIMIT 0');
    await pool.query('SELECT history_through FROM trader_analytics LIMIT 0');
    await pool.query('SELECT id, status, version, lease_token, lease_expires_at, run_attempts FROM backfill_jobs LIMIT 0');
    await pool.query('SELECT id, user_id, name FROM favorite_groups LIMIT 0');
    await pool.query('SELECT user_id, group_id, chain, address FROM favorite_group_members LIMIT 0');
    console.log('Persistent history schema is queryable after release migrations');
    console.log('Concurrent release migrations are repeatable');
  } finally { await pool.end(); }
});
