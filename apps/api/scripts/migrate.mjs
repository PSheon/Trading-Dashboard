import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Explicit release command: never run automatically in every API replica.
// No .env loading and no connection URL/error detail in logs.
const require = createRequire(import.meta.url);
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
    await migrate(drizzle(client), { migrationsFolder });
    console.log('Database migrations complete');
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(73104, 2)'); }
    finally { await client.end(); }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await migrateDatabase(process.env.DATABASE_URL); }
  catch { console.error('Database migration failed; verify connectivity, permissions and migration compatibility'); process.exitCode = 1; }
}
