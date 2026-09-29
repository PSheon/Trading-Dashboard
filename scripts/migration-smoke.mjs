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
    console.log('Concurrent release migrations are repeatable');
  } finally { await pool.end(); }
});
