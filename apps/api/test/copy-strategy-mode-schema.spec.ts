import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { copyStrategies } from '@trading-dashboard/shared/database';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';

let db: TestDb, userId: number;
const leader = `0x${'44'.repeat(20)}`;
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => { await truncateAll(db); userId = (await insertUser(db)).id; });
afterAll(closeTestDb);
async function insertActual(overrides: { allocated?: string; cash?: string; funding?: string; mode?: string } = {}) {
  return db.execute(sql`insert into copy_strategies (user_id,leader_address,mode,status,allocated,cash,funding,activated_at)
    values (${userId},${leader},${overrides.mode ?? 'testnet'},'paused',${overrides.allocated ?? '0'},${overrides.cash ?? '0'},${overrides.funding ?? '0'},now()) returning id`);
}
describe('separate actual strategy storage without simulated capital', () => {
  it('creates a dedicated paused testnet strategy with zero paper financial amounts', async () => {
    await insertActual();
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: 'testnet', status: 'paused', allocated: '0', cash: '0', funding: '0' });
  });
  it('allows paper and testnet strategies for the same leader while retaining per-mode active uniqueness', async () => {
    await db.insert(copyStrategies).values({ userId, leaderAddress: leader, allocated: '100', cash: '100', activatedAt: new Date() });
    await insertActual();
    expect(await db.select().from(copyStrategies)).toHaveLength(2);
    await expect(insertActual()).rejects.toThrow();
  });
  it('rejects simulated financial values on a testnet strategy', async () => {
    for (const overrides of [{ allocated: '100' }, { cash: '1' }, { funding: '-1' }]) await expect(insertActual(overrides)).rejects.toThrow();
    expect(await db.select().from(copyStrategies)).toHaveLength(0);
  });
  it('retains paper positive allocations and rejects unsupported strategy modes', async () => {
    await expect(db.insert(copyStrategies).values({ userId, leaderAddress: leader, allocated: '0', cash: '0', activatedAt: new Date() })).rejects.toThrow();
    await expect(insertActual({ mode: 'mainnet' })).rejects.toThrow();
  });
});
