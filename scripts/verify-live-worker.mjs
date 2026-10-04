/** Observe the running, real worker. No fixture writes, new provider sockets,
 * wallet signatures, or trades. Load the actual service DATABASE_URL explicitly. */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const runMs = Number(process.env.LIVE_WORKER_RUN_MS ?? 90_000);
const drainMs = Number(process.env.LIVE_WORKER_DRAIN_MS ?? 120_000);
if (![runMs, drainMs].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 300_000) || runMs < 15_000)
  throw new Error('Invalid observation duration');
if (!process.env.DATABASE_URL) throw new Error('The actual worker database must be configured');
const worker = new URL(process.env.LIVE_WORKER_HEALTH_URL ?? 'http://127.0.0.1:3101/health');
if (worker.username || worker.password || !['http:', 'https:'].includes(worker.protocol))
  throw new Error('Invalid worker health URL');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 15_000 });
const health = async () => {
  const response = await fetch(worker, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
  const value = await response.json();
  return { status: response.status, feedConnected: value.feedConnected,
    socketsOpen: value.feedSocketsOpen, socketsTotal: value.feedSocketsTotal,
    markets: value.marketsSubscribed, lastTradeAt: value.lastTradeAt,
    lastFillAt: value.lastFillAt, dryRun: value.dryRun };
};
try {
  // One database snapshot gives both the actual clock and the baseline. IDs and
  // timestamps are evidence of observations; they never authorize execution.
  const { rows: [baseline] } = await pool.query(`select clock_timestamp() as started_at,
    coalesce(max(id),0)::text as last_id from actions`);
  const before = await health(), startedAt = baseline.started_at;
  const deadline = Date.now() + runMs;
  while (Date.now() < deadline) {
    await delay(Math.min(15_000, deadline - Date.now()));
    const { rows: [sample] } = await pool.query(`select count(*)::int as new_actions
      from actions where id > $1::bigint and ts >= $2`, [baseline.last_id, startedAt]);
    console.log(JSON.stringify({ phase: 'observe', newActions: sample.new_actions }));
  }
  const endedAt = new Date(), during = await health();
  // Stop selecting new actions, while the already observed signals receive
  // their normal fill confirmations. The service continues running untouched.
  const { rows: [window] } = await pool.query(`select coalesce(max(id),0)::text as last_id from actions`);
  const drainDeadline = Date.now() + drainMs;
  while (Date.now() < drainDeadline) await delay(Math.min(15_000, drainDeadline - Date.now()));
  const { rows: [counts] } = await pool.query(`with observed as (
      select * from actions where id > $1::bigint and id <= $2::bigint and ts >= $3 and ts <= $4
    ), members as (
      select a.chain,a.address,t.tid from observed a cross join lateral unnest(a.fill_ids) t(tid)
    ) select (select count(*)::int from observed) as actions,
      (select count(*)::int from observed where cardinality(fill_ids)=0) as empty_actions,
      (select count(*)::int from members) as referenced_fills,
      (select count(*)::int from (select chain,address,tid from members group by chain,address,tid having count(*)>1) d) as duplicate_fill_memberships,
      (select count(*)::int from members m where not exists(select 1 from fills f
        where f.chain=m.chain and f.address=m.address and f.tid=m.tid)) as missing_fills`,
    [baseline.last_id, window.last_id, startedAt, endedAt]);
  const after = await health();
  const connected = [before, during, after].every(h => h.status === 200 && h.feedConnected === true &&
    h.socketsOpen > 0 && h.socketsOpen === h.socketsTotal && h.markets > 100);
  const passed = connected && during.lastTradeAt !== before.lastTradeAt && counts.actions > 0 &&
    counts.referenced_fills > 0 && counts.empty_actions === 0 && counts.missing_fills === 0 && counts.duplicate_fill_memberships === 0;
  const report = { kind: 'actual-running-worker-observation', startedAt, endedAt, verifiedAt: new Date(),
    runMs, drainMs, before, during, after, counts, passed,
    limitations: ['Read-only observation of the current service build',
      'Signal and stored-fill consistency; no owner-funded execution, latency guarantee or Copydog numeric equivalence'] };
  if (process.env.LIVE_WORKER_SUMMARY_FILE) await writeFile(process.env.LIVE_WORKER_SUMMARY_FILE,
    JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  // Database/provider errors can contain connection material. Codes only.
  console.error(JSON.stringify({ passed: false, error: error?.code ?? error?.name ?? 'ObservationFailed' }));
  process.exitCode = 1;
} finally { await pool.end(); }
