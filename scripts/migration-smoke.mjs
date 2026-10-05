import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { withTestDatabase } from './test-database.mjs';
import { migrateDatabase } from '../apps/api/scripts/migrate.mjs';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const { readMigrationFiles } = require('drizzle-orm/migrator');
const migrationFolder = new URL('../packages/shared/drizzle/', import.meta.url).pathname;
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
    // 0062: the platform control row and risk policy v1 are seeded once.
    const seeded = await pool.query("SELECT (SELECT count(*)::int FROM copy_controls WHERE scope = 'platform' AND scope_id = 0 AND NOT pause_new_risk AND NOT reduce_only) AS platform, (SELECT count(*)::int FROM copy_risk_policies WHERE reason = 'seeded defaults' AND created_by_user_id IS NULL) AS policies");
    assert.deepEqual(seeded.rows[0], { platform: 1, policies: 1 });
    console.log('Copy platform control row and risk policy v1 are seeded');
    // 0064: one-click setups, their consent kind on generations, and one active plus one renewing agent per account.
    await pool.query('SELECT id, user_id, strategy_id, account_id, kind, stage, signer_kind, intent, intent_digest, consent_digest, setup_deadline, lease_until FROM copy_live_setups LIMIT 0');
    await pool.query('SELECT consent_kind, live_setup_id FROM copy_live_mandates LIMIT 0');
    await pool.query('SELECT live_setup_id, signer_kind FROM copy_funding_operations LIMIT 0');
    const agentIndexes = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'copy_agent_setups' AND indexname IN ('copy_agent_setups_active_uq', 'copy_agent_setups_pending_uq', 'copy_agent_setups_current_uq') ORDER BY indexname");
    assert.deepEqual(agentIndexes.rows.map(row => row.indexname), ['copy_agent_setups_active_uq', 'copy_agent_setups_pending_uq']);
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
    // Rebuild only this owned disposable DB to the actual pre-0026 schema.
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('DROP SCHEMA drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('CREATE SCHEMA drizzle');
    await pool.query('CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
    const historical = readMigrationFiles({ migrationsFolder: migrationFolder });
    for (const entry of historical.filter(entry => entry.folderMillis < 1790959907204)) {
      for (const statement of entry.sql) await pool.query(statement);
      await pool.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [entry.hash, entry.folderMillis]);
    }
    const account = await pool.query('INSERT INTO history_accounts (address) VALUES ($1) RETURNING id', [`0x${'11'.repeat(20)}`]);
    await pool.query("INSERT INTO history_fills (account_id, tid, twap, time, origin) VALUES ($1, 1, false, now(), 'invalid-existing-origin')", [account.rows[0].id]);
    await assert.rejects(migrateDatabase(url));
    const deferred = await pool.query("SELECT convalidated FROM pg_constraint WHERE conname = 'history_fills_origin_check'");
    assert.equal(deferred.rows.length, 1, 'Online CHECK installation must survive failed historical validation');
    assert.equal(deferred.rows[0].convalidated, false);
    const incompleteJournal = await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE created_at >= $1', [1790959907204]);
    assert.equal(incompleteJournal.rows[0].count, 0, 'Historical validation must finish before the original journal reports 0026 complete');
    const { drizzle } = require('drizzle-orm/node-postgres');
    const { migrate } = require('drizzle-orm/node-postgres/migrator');
    await assert.rejects(migrate(drizzle(pool), { migrationsFolder: migrationFolder }), error => error.cause?.code === '42710', 'An older plain Drizzle runner must fail closed on the pending installed CHECKs');
    await assert.rejects(pool.query("INSERT INTO history_fills (account_id, tid, twap, time, origin) VALUES ($1, 2, false, now(), 'invalid-new-origin')", [account.rows[0].id]), { code: '23514' });
    await pool.query("UPDATE history_fills SET origin = 'rest' WHERE tid = 1");
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE history_fills IN SHARE UPDATE EXCLUSIVE MODE');
    const continuing = migrateDatabase(url); void continuing.catch(() => undefined);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const lock = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE relation = 'public.history_fills'::regclass AND mode = 'ShareUpdateExclusiveLock' AND NOT granted) AS waiting");
        waiting = lock.rows[0].waiting;
        if (!waiting) await delay(50);
      }
      assert.equal(waiting, true, 'Historical validation must request the concurrent-write-compatible lock');
      await pool.query("INSERT INTO history_fills (account_id, tid, twap, time, origin) VALUES ($1, 3, false, now(), 'rest')", [account.rows[0].id]);
      const readable = await pool.query('SELECT count(*)::int AS count FROM history_fills');
      assert.equal(readable.rows[0].count, 2, 'Reads and valid new writes proceed while validation waits');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await continuing; }
    const validated = await pool.query("SELECT convalidated FROM pg_constraint WHERE conname = 'history_fills_origin_check'");
    assert.equal(validated.rows[0].convalidated, true);
    const resumed = await pool.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
    assert.deepEqual(resumed.rows.map(row => ({ hash: row.hash, when: Number(row.created_at) })), historical.map(row => ({ hash: row.hash, when: row.folderMillis })));
    const marker = await pool.query('SELECT hash, state, validated_at FROM drizzle.__orbie_online_migrations WHERE created_at = $1', [1790959907204]);
    assert.equal(marker.rows[0].hash, historical.find(row => row.folderMillis === 1790959907204).hash);
    assert.equal(marker.rows[0].state, 'validated');
    assert.ok(marker.rows[0].validated_at);
    await pool.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1', [1790959907204]);
    await assert.rejects(migrateDatabase(url), /Completed migration journal mismatch/, 'A newer journal tail cannot conceal a missing completed 0026 entry');
    await pool.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [marker.rows[0].hash, 1790959907204]);
    await migrateDatabase(url);
    console.log('Historical validation failure retains new-write enforcement; corrected data resumes with original migration hashes');
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('DROP SCHEMA drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrateDatabase(url);
    const fresh = await pool.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
    assert.deepEqual(fresh.rows.map(row => ({ hash: row.hash, when: Number(row.created_at) })), historical.map(row => ({ hash: row.hash, when: row.folderMillis })));
    const pendingChecks = await pool.query("SELECT count(*)::int AS count FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND c.contype = 'c' AND NOT c.convalidated");
    assert.equal(pendingChecks.rows[0].count, 0);
    console.log('Fresh release installs the full original journal with all CHECK constraints validated');
  } finally { await pool.end(); }
});
