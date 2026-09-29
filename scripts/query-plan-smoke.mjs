import { createRequire } from 'node:module';
import { withTestDatabase } from './test-database.mjs';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
await withTestDatabase(async (url) => {
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`INSERT INTO actions(chain,address,coin,kind,side,notional_usd,avg_px,fill_ids,ts)
      SELECT 'hyperliquid', 'benchmark-' || (n % 1000), 'BTC','open','long',1,1,'{}',now() - n * interval '1 second' FROM generate_series(1,100000) n`);
    await pool.query('ANALYZE actions');
    const query = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ts FROM actions WHERE chain='hyperliquid' AND address='benchmark-999' ORDER BY ts DESC, id DESC LIMIT 1`;
    const result = await pool.query(query);
    console.log(JSON.stringify(result.rows[0]['QUERY PLAN'], null, 2));
  } finally { await pool.end(); }
});
