import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb } from './db-test-utils.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { readMeterKey } from '../src/hyperliquid/hyperliquid-meter-key.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { READ_WORKER_BACKGROUND_REST_CAP, READ_WORKER_PAGE_RESERVE } from '../src/config/constants/hyperliquid.js';

/**
 * Decision D12 on the real meter table: the read worker's process (a quota
 * built for the `read` meter, its transport on `<key>:read`) and the copy
 * side's (the default quota on `<key>`) each charge their own row and can not
 * charge the other's; on the read row background stops at 900 and a page
 * read still gets the 300 above it.
 */
let pool: Pool, db: ReturnType<typeof getTestDb>;
const keys: string[] = [];
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); });
afterEach(async () => { if (keys.length) await db.delete(schema.hyperliquidEgressQuota).where(inArray(schema.hyperliquidEgressQuota.egressKey, keys.splice(0))); });
afterAll(async () => { await pool.end(); await closeTestDb(); });

function processes() {
  const shared = `d12-${randomUUID()}`, own = readMeterKey(shared);
  keys.push(shared, own);
  const uow = () => new UnitOfWork(drizzle(pool, { schema }));
  // The read worker: HYPERLIQUID_READ_METER=own derives its key and its cap (runtime-config.ts).
  const readQuota = new PostgresHyperliquidQuota(uow(), undefined, undefined, READ_WORKER_BACKGROUND_REST_CAP, 'read');
  const readWorker = new HyperliquidGlobalTransport(readQuota, { egressKey: own, ownerId: 'worker-read' }, async () => Response.json({}));
  // The copy side: the api and the copy worker, as before D12.
  const copyQuota = new PostgresHyperliquidQuota(uow());
  const api = new HyperliquidGlobalTransport(copyQuota, { egressKey: shared, ownerId: 'api' }, async () => Response.json({}));
  return { shared, own, readQuota, readWorker, copyQuota, api };
}
const held = async (egressKey: string) => {
  const [row] = await db.select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
  return row ? row.events.reduce((sum, e) => sum + e.units, 0) : null;
};
const info = (type: string) => ['https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify({ type }) }] as const;

describe('the read worker and the copy side charge different meter rows (D12)', () => {
  it('a read worker\'s background read lands on `<key>:read` and leaves the shared row untouched; the api\'s on `<key>` only', async () => {
    const { shared, own, readWorker, api } = processes();
    await readWorker.fetchBackgroundInfo(...info('allMids'));
    expect(await held(own)).toBe(2);
    expect(await held(shared)).toBeNull();
    await api.fetchPageInfo(...info('meta'));
    expect(await held(shared)).toBe(20);
    expect(await held(own)).toBe(2);
  });
  it('neither process can bind the other\'s key: refused before any row exists', async () => {
    const { shared, own, readQuota, copyQuota } = processes();
    expect(() => readQuota.bindUnscoped({ egressKey: shared, ownerId: 'worker-read' })).toThrow('hyperliquid_quota_meter_foreign');
    expect(() => copyQuota.bindUnscoped({ egressKey: own, ownerId: 'api' })).toThrow('hyperliquid_quota_meter_foreign');
    const misbound = new HyperliquidGlobalTransport(copyQuota, { egressKey: own, ownerId: 'api' }, async () => Response.json({}));
    await expect(misbound.fetchBackgroundInfo(...info('allMids'))).rejects.toThrow('hyperliquid_quota_meter_foreign');
    expect(await held(shared)).toBeNull();
    expect(await held(own)).toBeNull();
    // Reading either row is not a charge: the admin overview shows both meters from one process.
    expect((await copyQuota.meterSnapshot(own)).rest.total).toBe(0);
    expect((await readQuota.laneStatus(shared)).pageLane.count).toBe(0);
  });
  it('on the read row background stops at 900 and a page read still gets the 300 above it', async () => {
    const { own, readWorker } = processes();
    const quota = readWorker.currentQuota(), deadline = () => Date.now() + 5000;
    for (let i = 0; i < READ_WORKER_BACKGROUND_REST_CAP / 100; i++) (await quota.acquireRest(100, deadline(), 'background')).dispatch(() => undefined);
    expect(await held(own)).toBe(READ_WORKER_BACKGROUND_REST_CAP);
    await expect(quota.acquireRest(1, deadline(), 'background')).rejects.toThrow(HyperliquidRestCapacityError);
    (await quota.acquireRest(READ_WORKER_PAGE_RESERVE, deadline(), 'page', { heldMs: 0 })).dispatch(() => undefined);
    expect(await held(own)).toBe(1200);
    await expect(quota.acquireRest(1, deadline(), 'page', { heldMs: 0 })).rejects.toThrow(HyperliquidRestCapacityError);
    const snapshot = await readWorker.meterSnapshot();
    expect(snapshot?.rest).toMatchObject({ background: READ_WORKER_BACKGROUND_REST_CAP, page: READ_WORKER_PAGE_RESERVE });
  });
});
