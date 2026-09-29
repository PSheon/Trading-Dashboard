import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTestDatabase } from './test-database.mjs';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
function pgEnv(raw) {
  const url = new URL(raw);
  return { ...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '5', PGOPTIONS: '' };
}
async function snapshot(pool) {
  const tables = await pool.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname, tablename");
  const result = {};
  for (const { schemaname, tablename } of tables.rows) {
    const quoted = [schemaname, tablename].map(v => '"' + v.replaceAll('"', '""') + '"').join('.');
    result[`${schemaname}.${tablename}`] = (await pool.query(`SELECT row_to_json(t) AS row FROM ${quoted} t ORDER BY row_to_json(t)::text`)).rows;
  }
  result.indexes = (await pool.query("SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname IN ('public','drizzle') ORDER BY schemaname, tablename, indexname")).rows;
  return result;
}
const started = Date.now();
const directory = await mkdtemp(join(tmpdir(), 'orbie-restore-'));
const dump = join(directory, 'synthetic.dump');
try {
  await withTestDatabase(async (source) => {
    const sourcePool = new Pool({ connectionString: source });
    try {
      await sourcePool.query(`
        INSERT INTO users(privy_user_id,role) VALUES ('did:privy:restore-admin','admin');
        INSERT INTO users(privy_user_id,disabled_at) VALUES ('did:privy:restore-disabled',now());
        INSERT INTO user_favorites(user_id,address,alert_enabled) VALUES (1,'0xsynthetic',true);
        INSERT INTO actions(chain,address,coin,kind,side,notional_usd,avg_px,fill_ids,ts)
          VALUES ('hyperliquid','0xsynthetic','BTC','open','long',123.45,123.45,'{9007199254740993}',now());
        INSERT INTO action_outbox(action_id,equity_usd) VALUES (1,1000);
        INSERT INTO notification_outbox(action_id,user_id,payload_json) VALUES (1,1,'{"version":1,"synthetic":true}');
        INSERT INTO admin_audit_logs(actor_kind,actor_user_id,event,target,after_json) VALUES ('user',1,'restore.fixture','2','{"disabled":true}');
      `);
      const expected = await snapshot(sourcePool);
      execFileSync(process.env.PG_DUMP ?? 'pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump], { env: pgEnv(source), stdio: 'pipe', timeout: 60000 });
      const bytes = (await stat(dump)).size;
      assert.ok(bytes > 0);
      await withTestDatabase(async (target) => {
        assert.notEqual(target, source);
        // --clean is confined to this random database owned by withTestDatabase.
        execFileSync(process.env.PG_RESTORE ?? 'pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', new URL(target).pathname.slice(1), dump], { env: pgEnv(target), stdio: 'pipe', timeout: 60000 });
        const targetPool = new Pool({ connectionString: target });
        try {
          assert.deepEqual(await snapshot(targetPool), expected);
          await assert.rejects(targetPool.query("INSERT INTO users(privy_user_id) VALUES ('did:privy:restore-admin')"), { code: '23505' });
          await assert.rejects(targetPool.query("INSERT INTO user_favorites(user_id,address) VALUES (999,'0xmissing')"), { code: '23503' });
          const next = await targetPool.query("INSERT INTO users(privy_user_id) VALUES ('did:privy:restore-next') RETURNING id");
          assert.ok(next.rows[0].id > 2, 'Restored sequence must advance past existing rows');
          console.log(`Restore verified all tables/indexes, ownership data, outboxes, audit, migration journal, constraints and sequences (${bytes} bytes; ${Date.now() - started} ms)`);
        } finally { await targetPool.end(); }
      });
    } finally { await sourcePool.end(); }
  });
} catch (error) {
  // Never echo a database URL or subprocess environment.
  console.error(`Synthetic restore verification failed (${error?.code ?? error?.name ?? 'unknown'}); check PostgreSQL client/server versions and local test configuration`);
  process.exitCode = 1;
} finally { await rm(directory, { recursive: true, force: true }); }
