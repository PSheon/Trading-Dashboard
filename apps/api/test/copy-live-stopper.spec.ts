import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveStopService } from '../src/copy/copy-live-stop.service.js';
import { CopyAdminLiveRepository } from '../src/copy/copy-admin-live.repository.js';
import { CopyAdminLiveService } from '../src/copy/copy-admin-live.service.js';
import { findCurrentWalletAuthorization } from '../src/copy/live/postgres-wallet-authorizations.js';
import { CopyLiveCloseService } from '../src/copy/copy-live-close.service.js';
import { CopyLiveCloseRepository } from '../src/copy/copy-live-close.repository.js';
import { AGENT_EXPIRY_STOP_MARGIN_MS, CopyLiveStopper, type StopCanceller } from '../src/copy/live-worker/copy-live-stopper.js';
import { CopyLiveSystemStops } from '../src/copy/copy-live-stop-system.js';
import { CopyLiveAutoReturn } from '../src/copy/live-worker/copy-live-auto-return.js';
import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { CopyLiveReturnRepository, expireStaleReturns } from '../src/copy/copy-live-return.repository.js';
import { CopyLiveStopWorkerRepository } from '../src/copy/live-worker/copy-live-stop-worker.repository.js';
import { CLOSE_NEVER_SENT, closeCloid, closeRetryDelayMs, closeSlippageBps, type CloseRequest, type ReduceOnlyCloser } from '../src/copy/live-worker/reduce-only-closer.js';
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
  network: 'testnet',
  observe: vi.fn(async () => snapshot()),
  close: vi.fn(async (request: CloseRequest) => { closes.push(request); const key = `testnet:${account()}:${closeCloid(request.seed)}`; await journal(key, 'submitting'); return { key, state: 'submitting' } as LiveExecutionRecord; }),
  // Reconciles a close the stop took over: the exchange says it filled.
  settle: vi.fn(async (_account: unknown, key: string) => { await journal(key, 'filled'); return { key, state: 'filled' } as LiveExecutionRecord; }),
} as unknown as ReduceOnlyCloser;
let swept = false, canceller: { cancel: ReturnType<typeof vi.fn> };
const stopper = () => new CopyLiveStopper({ repository: new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), testConfig()), closer, canceller: canceller as unknown as StopCanceller,
  swept: async () => swept }, () => clock);
const stopRow = async () => (await db.select().from(schema.copyLiveStopOperations))[0]!;

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db); clock = now; positions = []; withdrawable = '0'; resting = []; closes.length = 0; swept = false;
  canceller = { cancel: vi.fn(async () => 'stop_cancellation_authority_missing') };
  vi.mocked(closer.observe).mockClear(); vi.mocked(closer.close).mockClear(); vi.mocked(closer.settle).mockClear();
  await db.insert(schema.leaders).values({ address: seed.consent.leaderAddress, active: true, source: 'copy' });
  await new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())), new UnitOfWork(db), () => clock)
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

  it('an admin revoking the grant during a stop keeps it for the stop (reduce-only) and revokes it when the stop ends', async () => {
    const admin = new CopyAdminLiveService(new CopyAdminLiveRepository(db, testConfig()), new UnitOfWork(db), new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())));
    admin.now = () => new Date(clock);
    const stop = await stopRow();
    const revoked = await admin.revoke('grant', { reason: 'leaked agent key' }, { kind: 'user', id: 1, privyUserId: 'did:privy:risk-source', role: 'admin' } as never);
    expect(revoked).toEqual({ id: 'grant', version: 4, revokedAt: null, revokeRequestedAt: new Date(clock).toISOString(), stopId: stop.id });
    // No second stop; the existing one still closes with the grant.
    expect(await db.select().from(schema.copyLiveStopOperations)).toHaveLength(1);
    positions = [{ coin: 'BTC', size: '0.5' }];
    await stopper().tick(); await stopper().tick();
    expect(closes.map(c => c.coin)).toEqual(['BTC']);
    expect((await findCurrentWalletAuthorization(db, 'grant', 'stop'))?.scopes).toEqual(['copy:reduce']);
    expect((await findCurrentWalletAuthorization(db, 'grant'))?.scopes).toEqual([]);
    positions = []; await stopper().tick(); await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'stopped' });
    expect((await db.select().from(schema.copyWalletAuthorizations))[0]).toMatchObject({ version: 5, revokedAt: expect.any(Date) });
    expect(await db.select({ version: schema.copyWalletAuthorizationEvents.version, action: schema.copyWalletAuthorizationEvents.action }).from(schema.copyWalletAuthorizationEvents))
      .toEqual([{ version: 5, action: 'revoked' }]);
  });

  it('a flat account with funds waits for the owner\'s return to the main wallet', async () => {
    withdrawable = '25'; await stopper().tick(); await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'flat' });
    await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'flat', issue: 'stop_awaiting_return_to_main_wallet' });
    swept = true; await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'stopped' });
  });

  describe('the automatic return (one-click plan §3c)', () => {
    const main = `0x${'5a'.repeat(20)}`;
    let exchange: { send: ReturnType<typeof vi.fn> }, worker: { available: boolean; sign: ReturnType<typeof vi.fn> };
    const auto = () => new CopyLiveStopper({ repository: new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), testConfig()), closer, canceller: canceller as unknown as StopCanceller,
      swept: async () => swept, autoReturn: new CopyLiveAutoReturn('testnet', new CopyLiveReturnRepository(db, testConfig()), exchange as never, worker as never, () => clock) }, () => clock);
    const withSigner = () => db.update(schema.copyExecutionAccounts).set({ masterPolicyId: 'policy-1', masterPolicyFingerprint: 'c'.repeat(64), masterSignerQuorumId: 'worker',
      sweepDestination: main, signerAttachedAt: new Date(clock) });
    const returns = () => db.select().from(schema.copyFundingOperations).where(eq(schema.copyFundingOperations.direction, 'to_main'));
    beforeEach(async () => {
      await db.update(schema.users).set({ embeddedWalletAddress: main });
      exchange = { send: vi.fn(async () => ({ status: 'ok', response: { type: 'default' } })) };
      worker = { available: true, sign: vi.fn(async () => `0x${'11'.repeat(64)}1b`) };
    });

    it('sweeps everything withdrawable (6 decimals) to the main wallet once, signed by the worker, and the stop ends when it is credited', async () => {
      await withSigner(); withdrawable = '25.1234567';
      await auto().tick(); await auto().tick();
      expect(await stopRow()).toMatchObject({ state: 'flat' });
      await auto().tick();
      const stop = await stopRow();
      expect(stop.issue).toBe('stop_returning_to_main_wallet');
      const [row] = await returns();
      expect(row).toMatchObject({ idempotencyKey: `sweep:${stop.id}`, stopId: stop.id, amount: '25.123456', destination: main, status: 'accepted' });
      const [target, data, bound] = worker.sign.mock.calls[0]!;
      expect(target).toMatchObject({ workerQuorumId: 'worker', policyId: 'policy-1', address: account() });
      expect(data).toMatchObject({ primaryType: 'HyperliquidTransaction:UsdSend', message: { destination: main, amount: '25.123456', hyperliquidChain: 'Testnet' } });
      expect(bound).toEqual({ network: 'testnet', destination: main });
      // Never resent while it is in flight.
      await auto().tick();
      expect(worker.sign).toHaveBeenCalledTimes(1); expect(exchange.send).toHaveBeenCalledTimes(1); expect(await returns()).toHaveLength(1);
      swept = true; await auto().tick();
      expect(await stopRow()).toMatchObject({ state: 'stopped' });
    });

    it('an owner an admin disabled: the stop still closes with the grant, and the automatic return still sends the funds back', async () => {
      await db.update(schema.users).set({ disabledAt: new Date(clock) });
      // Nothing new is signed for a disabled owner, but the stop's closes are.
      expect(await findCurrentWalletAuthorization(db, 'grant')).toBeNull();
      expect((await findCurrentWalletAuthorization(db, 'grant', 'stop'))?.id).toBe('grant');
      await withSigner(); withdrawable = '25';
      await auto().tick(); await auto().tick(); await auto().tick();
      expect(await stopRow()).toMatchObject({ state: 'flat', issue: 'stop_returning_to_main_wallet' });
      expect((await returns())[0]).toMatchObject({ amount: '25', destination: main, status: 'accepted' });
      expect(exchange.send).toHaveBeenCalledTimes(1);
    });

    it('a legacy account (no master signer) waits for the owner\'s return, as before', async () => {
      withdrawable = '25'; await auto().tick(); await auto().tick(); await auto().tick();
      expect(await stopRow()).toMatchObject({ state: 'flat', issue: 'stop_awaiting_return_to_main_wallet' });
      expect(worker.sign).not.toHaveBeenCalled(); expect(await returns()).toEqual([]);
    });

    it('waits, instead of failing, while another wallet operation of the account is pending; a stale system sweep is never expired', async () => {
      await withSigner(); withdrawable = '25';
      await db.insert(schema.copyFundingOperations).values({ id: 'pending-deposit', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'pending-deposit-key',
        network: 'testnet', address: `0x${'77'.repeat(20)}`, destination: account(), amount: '5', nonce: clock, status: 'unknown' });
      await auto().tick(); await auto().tick(); await auto().tick();
      expect(await stopRow()).toMatchObject({ state: 'flat', issue: 'stop_return_waiting' });
      expect(await returns()).toEqual([]);
      await db.update(schema.copyFundingOperations).set({ status: 'cancelled' }).where(eq(schema.copyFundingOperations.id, 'pending-deposit'));
      worker.sign.mockRejectedValueOnce(new Error('privy down'));
      await auto().tick();
      // Not signed: refused, and the owner's manual return remains.
      expect((await returns())[0]).toMatchObject({ status: 'rejected' });
      await auto().tick();
      expect(await stopRow()).toMatchObject({ issue: 'stop_awaiting_return_to_main_wallet' });
    });

    it('a sweep whose send failed is never counted as sent: not dispatched it is refused (the owner returns it), dispatched it stays unconfirmed and is not resent', async () => {
      await withSigner(); withdrawable = '25';
      const sweep = () => new CopyLiveAutoReturn('testnet', new CopyLiveReturnRepository(db, testConfig()), exchange as never, worker as never, () => clock);
      // Refused before the POST (its proof went stale): nothing left the process.
      exchange.send.mockImplementationOnce(async (_row: unknown, _signature: string, fresh: () => void) => { clock += 60_000; fresh(); return null; });
      const stop = await auto().tick().then(() => auto().tick()).then(stopRow);
      expect(stop.state).toBe('flat');
      expect(await sweep().sweep(stop, withdrawable)).not.toBe('sent');
      expect((await returns())[0]).toMatchObject({ status: 'rejected' });
      // Sent, its answer lost: unknown, reconciled from the main wallet's ledger, never resent.
      await db.delete(schema.copyFundingOperations);
      exchange.send.mockImplementationOnce(async (_row: unknown, _signature: string, fresh: () => void) => { fresh(); throw new Error('socket hang up'); });
      expect(await sweep().sweep(stop, withdrawable)).toBe('unknown');
      expect((await returns())[0]).toMatchObject({ status: 'unknown' });
      expect(await sweep().sweep(stop, withdrawable)).toBe('unknown');
      expect(exchange.send).toHaveBeenCalledTimes(2);
    });

    it('a sweep whose quota permit is refused at the send was not dispatched: refused (the owner returns it), never left unconfirmed', async () => {
      await withSigner(); withdrawable = '25';
      const stop = await auto().tick().then(() => auto().tick()).then(stopRow);
      expect(stop.state).toBe('flat');
      const fetcher = vi.fn(async () => Response.json({ status: 'ok', response: { type: 'default' } })); vi.stubGlobal('fetch', fetcher);
      const global = Object.create(HyperliquidGlobalTransport.prototype) as HyperliquidGlobalTransport;
      const permit = { assertFresh: () => { throw new Error('hyperliquid_quota_expired'); }, dispatch: <T>(work: () => T) => work() };
      Object.defineProperty(global, 'currentQuota', { value: () => ({ acquireRest: async () => permit }) });
      const client = new CopyFundingExchangeClient({ acquire: vi.fn(async () => {}) } as unknown as RequestBudgeterService, global);
      try {
        expect(await new CopyLiveAutoReturn('testnet', new CopyLiveReturnRepository(db, testConfig()), client, worker as never, () => clock).sweep(stop, withdrawable)).toBe('failed');
      } finally { vi.unstubAllGlobals(); }
      expect(fetcher).not.toHaveBeenCalled();
      expect((await returns())[0]).toMatchObject({ status: 'rejected' });
    });

    it('a system sweep has no consent window: expireStaleReturns leaves it', async () => {
      const [acc] = await db.select().from(schema.copyExecutionAccounts);
      await db.insert(schema.copyFundingOperations).values({ id: 'system-sweep', userId: 1, accountId: acc!.id, strategyId: 9, idempotencyKey: 'sweep:old-stop', network: 'testnet',
        address: account(), destination: main, amount: '5', nonce: clock, direction: 'to_main', createdAt: new Date(clock - 3_600_000) });
      await db.transaction(tx => expireStaleReturns(tx, acc!.id));
      expect((await returns())[0]).toMatchObject({ status: 'prepared' });
    });
  });

  it('a close that ended unsent is shown on the stop, and the next pass builds a fresh close (attempt n+1)', async () => {
    positions = [{ coin: 'BTC', size: '0.5' }];
    await stopper().tick(); expect(await stopRow()).toMatchObject({ state: 'closing' });
    // The closer found attempt 0 still prepared (its signing failed) and ended it unsent.
    vi.mocked(closer.close).mockImplementationOnce(async (request: CloseRequest) => {
      closes.push(request); const key = `testnet:${account()}:${closeCloid(request.seed)}`; await journal(key, 'rejected');
      return { key, state: 'rejected', errorCode: CLOSE_NEVER_SENT } as LiveExecutionRecord;
    });
    await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'closing', issue: 'stop_close_not_sent' });
    await stopper().tick();
    expect(closes.map(c => c.seed.split(':').slice(-2).join(':'))).toEqual(['BTC:0', 'BTC:1']);
    expect(await stopRow()).toMatchObject({ state: 'closing', issue: 'stop_close_retrying' });
  });

  it('a stop never runs out of close attempts: retries back off, go at a wider price, and the stop says it is retrying', async () => {
    positions = [{ coin: 'BTC', size: '0.5' }];
    await stopper().tick(); expect(await stopRow()).toMatchObject({ state: 'closing' });
    const id = (await stopRow()).id;
    // Ten IOCs that found nothing at their price (the old limit: exhausted, never closed again).
    for (let n = 0; n < 10; n++) await journal(`testnet:${account()}:${closeCloid(`stop:${id}:BTC:${n}`)}`, 'cancelled');
    await stopper().tick();
    expect(closes).toEqual([]);
    expect(await stopRow()).toMatchObject({ state: 'closing', issue: 'stop_close_retrying' });
    clock += closeRetryDelayMs(10); await stopper().tick();
    expect(closes.map(c => [c.seed.split(':').at(-1), c.attempt])).toEqual([['10', 10]]);
    expect(await stopRow()).toMatchObject({ state: 'closing', issue: 'stop_close_retrying' });
  });

  it('close retries: no wait for the first, then 5 s doubling to 5 min; the price widens by half the slippage per attempt, within 5 %', () => {
    expect([0, 1, 2, 3, 4, 9, 10, 50].map(closeRetryDelayMs)).toEqual([0, 0, 5000, 10_000, 20_000, 300_000, 300_000, 300_000]);
    expect([0, 1, 2, 4, 8, 20].map(n => closeSlippageBps(100, n))).toEqual([100, 150, 200, 300, 500, 500]);
    expect(closeSlippageBps(900, 3)).toBe(900);
  });

  it('a stop asked for while the owner\'s single-position close is in flight waits for that close and finishes it, instead of being blocked for ever', async () => {
    // Undo the stop of beforeEach: the copy runs again.
    await db.delete(schema.copyLiveStopOperations); await db.update(schema.copyStrategies).set({ status: 'active', pauseNewRisk: false, reduceOnly: false });
    await db.update(schema.copyLiveMandates).set({ state: 'active' });
    const key = `testnet:${account()}:${closeCloid('manual:close-1:0')}`;
    await db.insert(schema.copyLiveManualCloses).values({ id: 'close-1', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: '12121212-1212-4121-8121-121212121212', coin: 'BTC',
      executionKeys: [key], createdAt: new Date(clock), updatedAt: new Date(clock) });
    await journal(key, 'submitting');
    const [mandate] = await db.select().from(schema.copyLiveMandates);
    await new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())), new UnitOfWork(db), () => clock)
      .request(1, 'mandate', { idempotencyKey: 'stop-request-key-0002', expectedMandateRevision: mandate!.revision });
    const stop = await stopRow();
    expect(stop).toMatchObject({ state: 'requested', trackingComplete: true, issue: null, trackedExecutionCount: 0 });
    expect(stop.targetManifest).toMatchObject({ ownerCloses: [{ key, state: 'submitting' }] });
    positions = [{ coin: 'BTC', size: '0.2' }];
    await stopper().tick();
    expect(closer.settle).toHaveBeenCalledWith(expect.objectContaining({ accountAddress: account() }), key);
    expect(await stopRow()).toMatchObject({ state: 'requested', issue: 'stop_waiting_for_orders' });
    await stopper().tick(); expect(await stopRow()).toMatchObject({ state: 'closing' });
    await stopper().tick(); expect(closes.map(c => c.coin)).toEqual(['BTC']);
  });

  it('a copy whose agent expires within a day is stopped (close, then return) while the agent still signs', async () => {
    // Undo the stop of beforeEach: the copy runs again.
    await db.delete(schema.copyLiveStopOperations); await db.update(schema.copyStrategies).set({ status: 'active', pauseNewRisk: false, reduceOnly: false });
    await db.update(schema.copyLiveMandates).set({ state: 'active' });
    // A deployment that executes actual copies (COPY_TRADING_MODE testnet).
    const base = testConfig(), live = { get value() { return { ...base.value, copy: { ...base.value.copy, live: { network: 'testnet' } } }; } } as unknown as typeof base;
    const system = new CopyLiveSystemStops(db, new UnitOfWork(db), new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, live)), live);
    system.now = () => clock;
    const expiring = () => new CopyLiveStopper({ repository: new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), testConfig()), closer, canceller: canceller as unknown as StopCanceller,
      swept: async () => swept, systemStops: { agentExpiryMarginMs: AGENT_EXPIRY_STOP_MARGIN_MS, stopExpiring: margin => system.stopExpiring(margin), resumePendingCloseAll: async () => [] } }, () => clock);
    await db.update(schema.copyAgentSetups).set({ expiresAt: new Date(clock + 25 * 3_600_000) });
    await expiring().tick();
    expect(await db.select().from(schema.copyLiveStopOperations)).toEqual([]);
    await db.update(schema.copyAgentSetups).set({ expiresAt: new Date(clock + 23 * 3_600_000) });
    positions = [{ coin: 'BTC', size: '0.5' }];
    await expiring().tick();
    const stop = await stopRow();
    // Created and, in the same pass, moved on (nothing in flight).
    expect(stop).toMatchObject({ state: 'closing', trackingComplete: true });
    expect(stop.idempotencyKey).toMatch(/^agent-expiry-agent-mandate-\d+$/);
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'stopping' });
    // Worked like any stop: its close goes out.
    await expiring().tick();
    expect(closes.map(c => c.seed.split(':').slice(-2).join(':'))).toEqual(['BTC:0']);
    expect(await db.select().from(schema.copyLiveStopOperations)).toHaveLength(1);
  });

  it('tracked resting orders need the owner\'s cancellation consent; untracked orders block the close', async () => {
    const tracked = `testnet:${account()}:0x${'cd'.repeat(16)}`; await journal(tracked, 'resting');
    await stopper().tick(); expect(await stopRow()).toMatchObject({ state: 'cancelling' });
    await stopper().tick();
    expect(await stopRow()).toMatchObject({ state: 'cancelling', issue: 'stop_cancellation_authority_missing' });
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
    expect(await new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), testConfig()).move(stale, 'flat')).toBeNull();
    expect(await stopRow()).toMatchObject({ state: 'closing' });
  });

  it('pausing or revoking consent during a stop is refused and never moves the strategy back to paused', async () => {
    const mandates = new CopyLiveMandateRepository(db, testConfig()), uow = new UnitOfWork(db);
    await expect(uow.run(tx => mandates.barrier(tx, 1, 'mandate', 'revoked', () => clock))).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'stopping' });
  });

  it('a single-position close is refused while a stop runs; outside a stop one open close per market', async () => {
    const closes = new CopyLiveCloseService(new CopyLiveCloseRepository(db, testConfig()), () => clock);
    await expect(closes.request(1, 'account', { idempotencyKey: '66666666-6666-4666-8666-666666666666', coin: 'BTC' })).rejects.toMatchObject({ status: 409, response: { code: 'copy_stopping' } });
    await db.delete(schema.copyLiveStopOperations); await db.update(schema.copyStrategies).set({ status: 'active', pauseNewRisk: false, reduceOnly: false });
    const first = await closes.request(1, 'account', { idempotencyKey: '77777777-7777-4777-8777-777777777777', coin: 'BTC' });
    expect(first).toMatchObject({ state: 'requested', coin: 'BTC' });
    expect(await closes.request(1, 'account', { idempotencyKey: '77777777-7777-4777-8777-777777777777', coin: 'BTC' })).toEqual(first);
    await expect(closes.request(1, 'account', { idempotencyKey: '88888888-8888-4888-8888-888888888888', coin: 'BTC' })).rejects.toMatchObject({ status: 409, response: { code: 'close_pending' } });
    await expect(closes.request(1, 'account', { idempotencyKey: '99999999-9999-4999-8999-999999999999', coin: 'bad coin' })).rejects.toMatchObject({ status: 400 });
    expect((await closes.list(1, 'account')).items).toHaveLength(1);
    expect((await closes.list(2, 'account')).items).toHaveLength(0);
  });
});

