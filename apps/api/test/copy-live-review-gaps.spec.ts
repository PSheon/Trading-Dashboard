import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { assertCloseWithinPosition } from '../src/copy/live-worker/reduce-only-closer.js';
import { buildOrderAction, type LiveOrderIntent } from '../src/copy/live/live-order.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Tests the testnet regression review named as missing (6e).
describe('a reduce-only close never opens, enlarges or flips', () => {
  it('refuses a close larger than the position, on the same side, or with no position (close_exceeds_position)', () => {
    expect(() => assertCloseWithinPosition({ side: 'A', size: '0.5' }, { size: '0.5' })).not.toThrow();
    expect(() => assertCloseWithinPosition({ side: 'B', size: '1' }, { size: '-2' })).not.toThrow();
    expect(() => assertCloseWithinPosition({ side: 'A', size: '0.51' }, { size: '0.5' })).toThrow('close_exceeds_position');
    expect(() => assertCloseWithinPosition({ side: 'B', size: '0.1' }, { size: '0.5' })).toThrow('close_exceeds_position');
    expect(() => assertCloseWithinPosition({ side: 'A', size: '0.1' }, { size: '0' })).toThrow('close_exceeds_position');
    expect(() => assertCloseWithinPosition({ side: 'A', size: '0.1' }, undefined)).toThrow('close_exceeds_position');
  });
});

describe('a HIP-3 (builder dex) order', () => {
  const base = { authorizationId: 'grant', userId: 1, strategyId: 9, walletId: 'agent', network: 'testnet' as const, accountAddress: `0x${'55'.repeat(20)}` as `0x${string}`,
    cloid: `0x${'ab'.repeat(16)}` as `0x${string}`, side: 'B' as const, size: '1.5', limitPrice: '250.12', sizeDecimals: 2, timeInForce: 'Ioc' as const, reduceOnly: false };
  const market = { network: 'testnet' as const, coin: 'xyz:TSLA', dex: 'xyz', perpDexIndex: 1, universeIndex: 3, asset: 110_003, sizeDecimals: 2, maxLeverage: 10, observedAt: now };
  it('is sent with the builder dex asset id (100000 + dex × 10000 + index) from its proven market identity', () => {
    const action = buildOrderAction({ ...base, asset: 110_003, market } as LiveOrderIntent);
    expect(action.orders[0]).toMatchObject({ a: 110_003, b: true, p: '250.12', s: '1.5', r: false });
  });
  it('is refused without a market identity, or when the asset does not match it', () => {
    expect(() => buildOrderAction({ ...base, asset: 110_003 } as LiveOrderIntent)).toThrow('live_market_identity_missing');
    expect(() => buildOrderAction({ ...base, asset: 110_004, market } as LiveOrderIntent)).toThrow('live_market_identity_mismatch');
  });
});

describe('a leader reduction after the owner closed the position by hand', () => {
  let db: TestDb, seed: Awaited<ReturnType<typeof preparationFixture>>;
  beforeEach(async () => { db = getTestDb(); seed = await preparationFixture(db); });
  afterAll(async () => { await closeTestDb(); });
  const dispatch = (createdAt: number) => ({ id: `leg-${createdAt}`, mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: seed.fill.id, leg: 'open' as const,
    coin: 'BTC', state: 'settled' as const, executionKey: 'exec-open', leaderTime: new Date(createdAt), receivedAt: new Date(createdAt), createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
    settledAt: new Date(createdAt + 100) });
  beforeEach(async () => {
    await db.insert(schema.copyLiveExecutions).values({ key: 'exec-open', network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
      cloid: `0x${'ee'.repeat(16)}`, nonce: now, userId: 1, strategyId: 9, state: 'filled', updatedAt: new Date(now), record: { key: 'exec-open', state: 'filled' } });
  });
  const close = (coin: string, state: 'requested' | 'done', updatedAt: number) => ({ id: `close-${coin}-${updatedAt}`, userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: `close-key-${coin}-${updatedAt}`,
    coin, state, executionKeys: [`testnet:close:${coin}-${updatedAt}`], createdAt: new Date(updatedAt - 1000), updatedAt: new Date(updatedAt) });
  it('is position_closed_by_owner only for a finished close of that coin after the latest open', async () => {
    const repo = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(false); // never opened
    await db.insert(schema.copyLiveDispatches).values(dispatch(now - 10_000));
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(false);
    await db.insert(schema.copyLiveManualCloses).values(close('BTC', 'requested', now - 5_000));
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(false); // not finished
    await db.insert(schema.copyLiveManualCloses).values(close('ETH', 'done', now - 5_000));
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(false); // another coin
    await db.insert(schema.copyLiveManualCloses).values(close('BTC', 'done', now - 4_000));
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(true);
  });
  // CP-EXE-16: Hyperliquid liquidated the copy account (its own fill marker).
  const receipt = (tid: number, coin: string, at: number, liquidatedUser: string | null) => ({ key: `testnet:${seed.f.identity.accountAddress}:${tid}`, accountId: 'account', network: 'testnet' as const,
    accountAddress: seed.f.identity.accountAddress, kind: 'fill' as const, sourceId: String(tid), coin, providerTime: new Date(at), digest: 'a'.repeat(64), attribution: 'account' as const,
    record: { tid: String(tid), coin, raw: { tid, coin, ...(liquidatedUser ? { liquidation: { liquidatedUser, markPx: '1', method: 'market' } } : {}) } } });
  it('is position_liquidated only for the exchange liquidating this account on that coin after the latest open', async () => {
    const repo = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    const self = seed.f.identity.accountAddress.toUpperCase().replace('0X', '0x');
    await db.insert(schema.copyFollowerReceipts).values(receipt(1, 'BTC', now - 5_000, self));
    expect(await repo.liquidatedSinceOpen('mandate', 'account', 'BTC')).toBe(false); // never opened
    await db.insert(schema.copyLiveDispatches).values(dispatch(now - 4_000));
    expect(await repo.liquidatedSinceOpen('mandate', 'account', 'BTC')).toBe(false); // before the open
    await db.insert(schema.copyFollowerReceipts).values([receipt(2, 'ETH', now - 3_000, self), receipt(3, 'BTC', now - 3_000, null), receipt(4, 'BTC', now - 3_000, `0x${'99'.repeat(20)}`)]);
    expect(await repo.liquidatedSinceOpen('mandate', 'account', 'BTC')).toBe(false); // another coin, a plain fill, another user's liquidation
    await db.insert(schema.copyFollowerReceipts).values(receipt(5, 'BTC', now - 2_000, self));
    expect(await repo.liquidatedSinceOpen('mandate', 'account', 'BTC')).toBe(true);
  });
  it('is not, once the copy opened the coin again after that close', async () => {
    const repo = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    await db.insert(schema.copyLiveDispatches).values(dispatch(now - 10_000));
    await db.insert(schema.copyLiveManualCloses).values(close('BTC', 'done', now - 8_000));
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(true);
    // The latest open of the coin is now after that close.
    await db.update(schema.copyLiveDispatches).set({ createdAt: new Date(now - 2_000), settledAt: new Date(now - 1_900) });
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(false);
  });
});
