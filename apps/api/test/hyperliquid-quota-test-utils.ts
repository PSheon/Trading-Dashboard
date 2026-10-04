import { vi } from 'vitest';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { DrizzleDb } from '../src/db/drizzle.provider.js';

/** Offline fixture only. Persistence/capacity are exercised separately by
 * the PostgreSQL quota suite; this keeps native-fetch validation tests local. */
export function offlineGlobalTransport(fetcher: typeof fetch = fetch) {
  const quota = new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
  const acquire = vi.fn(async () => { let consumed = false; return { assertFresh: () => {}, dispatch: <T>(work: () => T): T => {
    if (consumed) throw Error('Offline permit consumed'); consumed = true; return work();
  } }; });
  vi.spyOn(quota, 'bindUnscoped').mockReturnValue({ acquireRest: acquire, reserveSocket: vi.fn() });
  return { transport: new HyperliquidGlobalTransport(quota, { egressKey: 'offline-fixture', ownerId: 'offline-worker' }, fetcher), acquire };
}
