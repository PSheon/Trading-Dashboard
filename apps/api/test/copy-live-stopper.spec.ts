import * as schema from '@trading-dashboard/shared/database';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveStopService } from '../src/copy/copy-live-stop.service.js';
import { CopyLiveStopper, type StopCanceller } from '../src/copy/live-worker/copy-live-stopper.js';
import { CopyLiveStopWorkerRepository } from '../src/copy/live-worker/copy-live-stop-worker.repository.js';
import { closeCloid, type CloseRequest, type TestnetReduceOnlyCloser } from '../src/copy/live-worker/reduce-only-closer.js';
import type { LiveAccountSnapshot } from '../src/copy/live/live-account-observer.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Real SQL for stop rows, generations, strategy and journals; the closer
// (observation + reduce-only orders) and canceller are doubles.
let db: TestDb, seed: Awaited<ReturnType<typeof preparationFixture>>, clock: number;
let positions: { coin: string; size: string }[], withdrawable: string, resting: { cloid: string | null }[];
const closes: CloseRequest[] = [];
const account = () => seed.f.identity.accountAddress;
const snapshot = (): LiveAccountSnapshot => ({ ...seed.f.accountSource.snapshot, observedAt: clock, completedAt: clock, withdrawable, perpEquity: withdrawable,
  positions: positions.map(p => ({ ...p, dex: '', asset: 0, sizeDecimals: 2, entryPrice: '100', positionValue: '1', unrealizedPnl: '0', marginUsed: '0.1', leverage: 10,
    leverageType: 'cross', maxLeverage: 20, fundingSinceOpen: '0', fundingSinceChange: '0' })),
  restingOrders: resting.map((o, i) => ({ coin: 'BTC', dex: '', asset: 0, oid: String(900 + i), side: 'A', limitPrice: '100', remainingSize: '1', originalSize: '1',
    notionalUsd: '100', reduceOnly: false, timestamp: clock, cloid: o.cloid })) } as LiveAccountSnapshot);
let nonce = 0;
async function journal(key: string, state: string, expiresAfter = clock + 60_000) {
  const cloid = key.split(':').at(-1)!; nonce += 1;
  const record = { key, fingerprint: 'f', authorization: { network: 'testnet', accountAddress: account(), signerAddress: `0x${'33'.repeat(20)}`, userId: 1, strategyId: 9 },
    action: { type: 'order', orders: [{ a: 0, b: false, p: '99', s: '1', r: true, t: { limit: { tif: 'Ioc' } }, c: cloid }], grouping: 'na' }, nonce: clock + nonce, expiresAfter, state, createdAt: clock, updatedAt: clock };
  await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: account(), signerAddress: `0x${'33'.repeat(20)}`, cloid, nonce: clock + nonce,
    userId: 1, strategyId: 9, state, record, updatedAt: new Date(clock) }).onConflictDoUpdate({ target: schema.copyLiveExecutions.key, set: { state, record: sql`jsonb_set(${schema.copyLiveExecutions.record}, '{state}', to_jsonb(${state}::text))` } });
}
const closer = {
  observe: vi.fn(async () => snapshot()),
  close: vi.fn(async (request: CloseRequest) => { closes.push(request); const key = `testnet:${account()}:${closeCloid(request.seed)}`; await journal(key, 'submitting'); return { key, state: 'submitting' } as LiveExecutionRecord; }),
} as unknown as TestnetReduceOnlyCloser;
let swept = false, canceller: { cancel: ReturnType<typeof vi.fn> };
const stopper = () => new CopyLiveStopper({ repository: new CopyLiveStopWorkerRepository(db, new UnitOfWork(db)), closer, canceller: canceller as unknown as StopCanceller,
  swept: async () => swept }, () => clock);
const stopRow = async () => (await db.select().from(schema.copyLiveStopOperations))[0]!;

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db); clock = now; positions = []; withdrawable = '0'; resting = []; closes.length = 0; swept = false;
  canceller = { cancel: vi.fn(async () => 'stop_cancellation_consent_required') };
  vi.mocked(closer.observe).mockClear(); vi.mocked(closer.close).mockClear();
  await db.insert(schema.leaders).values({ address: seed.consent.leaderAddress, active: true, source: 'copy' });
  await new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db)), new UnitOfWork(db), () => clock)
    .request(1, 'mandate', { idempotencyKey: 'stop-request-key-0001', expectedMandateRevision: 2 });
});
afterAll(async () => { await closeTestDb(); });

describe('testnet stop execution', () => {
  it('waits for in-flight orders, closes every position with a fixed order identity, confirms flat and ends the copy', async () => {
    expect(await stopRow()).toMatchObject({ state: 'requested' });
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'stopping', pauseNewRisk: true, reduceOnly: true });
    const inflight = `testnet:${account()}:0x${'ab'.repeat(16)}`; await journal(inflight, 'unknown');
    await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'requested', issue: 'stop_waiting_for_orders' });
    await journal(inflight, 'filled'); positions = [{ coin: 'BTC', size: '0.19' }, { coin: 'ETH', size: '-2' }];
    await stopper().tick(); expect(await stopRow()).toMatchObject({ state: 'closing' });
    await stopper().tick();
    expect(closes.map(c => [c.coin, c.seed])).toEqual([['BTC', `stop:${(await stopRow()).id}:BTC:0`], ['ETH', `stop:${(await stopRow()).id}:ETH:0`]]);
    expect(await closes[0]!.stillWanted()).toBe(true);
    // BTC filled only partly: the next pass sends attempt 1 for it; ETH's attempt 0 is still being reconciled.
    await journal(`testnet:${account()}:${closeCloid(closes[0]!.seed)}`, 'partial'); positions = [{ coin: 'BTC', size: '0.09' }, { coin: 'ETH', size: '-2' }];
    closes.length = 0; await stopper().tick();
    expect(closes.map(c => c.seed.split(':').slice(-2).join(':'))).toEqual(['BTC:1', 'ETH:0']);
    positions = []; await stopper().tick();
    const flat = await stopRow();
    expect(flat).toMatchObject({ state: 'flat' }); expect(flat.flatDigest).toMatch(/^[0-9a-f]{64}$/); expect(flat.flatCertificate).toMatchObject({ positions: [], restingOrders: [] });
    await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'stopped' });
    expect((await db.select().from(schema.copyLiveMandates))[0]).toMatchObject({ state: 'stopped' });
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'stopped' });
    expect((await db.select().from(schema.leaders).where(eq(schema.leaders.address, seed.consent.leaderAddress)))[0]).toMatchObject({ active: false });
    expect(await closes[0]!.stillWanted()).toBe(false);
  });

  it('a flat account with funds waits for the owner\'s return to the main wallet', async () => {
    withdrawable = '25'; await stopper().tick(); await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'flat' });
    await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'flat', issue: 'stop_awaiting_return_to_main_wallet' });
    swept = true; await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'stopped' });
  });

  it('tracked resting orders need the owner\'s cancellation consent; untracked orders block the close', async () => {
    const tracked = `testnet:${account()}:0x${'cd'.repeat(16)}`; await journal(tracked, 'resting');
    await stopper().tick(); expect(await stopRow()).toMatchObject({ state: 'cancelling' });
    await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'cancelling', issue: 'stop_cancellation_consent_required' });
    expect(canceller.cancel).toHaveBeenCalledOnce();
    await journal(tracked, 'cancelled'); await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'closing' });
    resting = [{ cloid: null }]; positions = [{ coin: 'BTC', size: '1' }];
    await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'closing', issue: 'stop_untracked_resting_orders' }); expect(closes).toHaveLength(0);
  });

  it('ignores an expired never-sent prepared order, and a stale pass changes nothing', async () => {
    await journal(`testnet:${account()}:0x${'ef'.repeat(16)}`, 'prepared', clock - 1);
    const stale = await stopRow(); await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'closing' });
    expect(await new CopyLiveStopWorkerRepository(db, new UnitOfWork(db)).move(stale, 'flat')).toBeNull();
    expect(await stopRow()).toMatchObject({ state: 'closing' });
  });

  it('pausing or revoking consent during a stop is refused and never moves the strategy back to paused', async () => {
    const mandates = new CopyLiveMandateRepository(db), uow = new UnitOfWork(db);
    await expect(uow.run(tx => mandates.barrier(tx, 1, 'mandate', 'revoked', () => clock))).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'stopping' });
  });

  it('the owner\'s cancellation consent: a challenge only while cancelling, bound to the stop revision; a foreign signature is refused', async () => {
    const service = new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db)), new UnitOfWork(db), () => clock);
    const stop = await stopRow();
    await expect(service.cancellationChallenge(1, stop.id)).rejects.toMatchObject({ status: 409 });
    await journal(`testnet:${account()}:0x${'cd'.repeat(16)}`, 'resting'); await stopper().tick();
    const cancelling = await stopRow(); expect(cancelling.state).toBe('cancelling');
    const challenge = await service.cancellationChallenge(1, stop.id);
    expect(challenge).toMatchObject({ stopId: stop.id, consented: false, intent: { stopId: stop.id, capturedStopRevision: cancelling.revision, targetDigest: cancelling.targetDigest,
      purpose: 'cancel_tracked_orders', agentAddress: `0x${'33'.repeat(20)}`, ownerAddress: cancelling.ownerAddress, nonce: clock, consentExpiresAt: clock + 30000, expiresAt: clock + 60000 } });
    expect(await service.cancellationChallenge(1, stop.id)).toEqual(challenge); // the same intent until it nears expiry
    await expect(service.cancellationChallenge(2, stop.id)).rejects.toMatchObject({ status: 404 });
    const { privateKeyToAccount } = await import('viem/accounts');
    const { liveStopCancellationOwnerTypedData } = await import('@trading-dashboard/shared/contracts');
    const foreign = await privateKeyToAccount(`0x${'09'.repeat(32)}`).signTypedData(liveStopCancellationOwnerTypedData(challenge.intent));
    await expect(service.approveCancellation(1, stop.id, { consentSignature: foreign })).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(schema.copyLiveStopConsents))[0]).toMatchObject({ consentDigest: null, verifiedAt: null });
  });
});

