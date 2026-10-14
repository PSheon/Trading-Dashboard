import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { HyperliquidLiveSourceClient } from '../src/copy/copy-live-source.client.js';
import { HyperliquidBudgetWait } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';

import { CopyLiveApiSettlementRepository } from '../src/copy/live-worker/copy-live-api-settlement.repository.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { LiveRiskBusyError } from '../src/copy/live/postgres-live-risk-scope.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { NEVER_PLACED, type LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import { buildOrderAction } from '../src/copy/live/live-order.js';
import { planLiveReservation } from '../src/copy/live/live-risk-reservation.js';
import type { LiveExecutionHooks, LiveExecutionRequest } from '../src/copy/live/live-execution-runtime.js';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import type { LiveSettleOutcome, LiveSettleRequest } from '../src/copy/live-worker/copy-live-settler.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
/** What the account observer throws when what failed underneath was `cause` (LiveObservationUnavailable). */
const unavailable = (cause: unknown) => Object.assign(new LiveBoundaryError('live_account_observation_unavailable'), { cause });
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';
import { CLOSE_ATTEMPT_LIMIT, MAX_LIVE_LEG_ATTEMPTS } from '../src/config/constants/limits.js';

// Real SQL, real watched-source reads and source repository; the runtime
// (signing/exchange) and the settler are doubles that record their calls.
let db: TestDb, clock: number, seed: Awaited<ReturnType<typeof preparationFixture>>;
const leader = `0x${'44'.repeat(20)}`;
type Runtime = (request: LiveExecutionRequest, hooks: Pick<LiveExecutionHooks, 'onExchange'>) => Promise<LiveExecutionRecord>;
let runtimeImpl: Runtime, settleImpl: (request: LiveSettleRequest) => Promise<LiveSettleOutcome>;
const runtimeCalls: LiveExecutionRequest[] = [], settleCalls: LiveSettleRequest[] = [];
const keyOf = (fillId: string, leg: 'open' | 'close') => `testnet:${seed.f.identity.accountAddress}:${liveSourceExecutionCloid('mandate', fillId, leg)}`;

async function journal(key: string, state: string) {
  await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
    cloid: key.split(':').at(-1)!, nonce: clock, userId: 1, strategyId: 9, state, record: { key }, updatedAt: new Date(clock) })
    .onConflictDoUpdate({ target: schema.copyLiveExecutions.key, set: { state } });
}
/** A filled order the double "sent": journal row plus exchange timings. */
const filled: Runtime = async (request, hooks) => {
  runtimeCalls.push(request);
  const key = keyOf(request.sourceFillId, request.leg);
  hooks.onExchange?.({ phase: 'request', at: clock + 10 }); hooks.onExchange?.({ phase: 'response', at: clock + 40 });
  await journal(key, 'filled');
  return { key, state: 'filled' } as LiveExecutionRecord;
};

function engine(extra: Partial<LiveEngineDependencies> = {}, testnetSourceIntervalMs = 60_000) {
  return new CopyLiveEngine({
    network: 'testnet', repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db, () => clock),
    testnetSource: { read: vi.fn(async () => { throw new Error('no testnet source in this test'); }) } as never,
    runtime: hooks => ({ execute: request => runtimeImpl(request, hooks) }),
    settler: { settle: async request => { settleCalls.push(request); return settleImpl(request); } },
    ...extra,
  }, { testnetSourceIntervalMs, sourceLagMs: 0, passBudgetMs: 60_000 }, () => clock);
}
/** The leader's REST-confirmed mainnet fill, as the market watcher stores it. */
async function leaderFill(tid: number, time: number, side: 'B' | 'A', sz: string, startPosition: string, coin = 'BTC') {
  const raw = { coin, px: '100', sz, side, time, startPosition, dir: side === 'B' ? 'Open Long' : 'Close Long', closedPnl: '0', hash: `0x${'12'.repeat(32)}`,
    oid: 1000 + tid, crossed: true, fee: '0.01', tid, feeToken: 'USDC' };
  await db.insert(schema.fills).values({ address: leader, tid: BigInt(tid), coin, side, dir: raw.dir, px: '100', sz, fee: '0.01', hash: raw.hash, ts: new Date(time), raw });
  return `mainnet:${leader}:${tid}`;
}
async function coverage(from: number, through: number) {
  await db.insert(schema.fillCoverage).values({ address: leader, verifiedFrom: new Date(from), verifiedThrough: new Date(through), backfillFloor: new Date(from) })
    .onConflictDoUpdate({ target: [schema.fillCoverage.chain, schema.fillCoverage.address], set: { verifiedThrough: new Date(through) } });
}
async function credit() {
  await db.insert(schema.copyFundingOperations).values({ id: 'fund', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'fund-key-0000000001', network: 'testnet',
    address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '100', nonce: 1, status: 'credited', claimedAt: new Date(now - 9000), attemptedAt: new Date(now - 9000),
    evidenceHash: 'a'.repeat(64), transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '99', fee: '1' });
}
const dispatches = () => db.select().from(schema.copyLiveDispatches).orderBy(schema.copyLiveDispatches.leaderTime, schema.copyLiveDispatches.leg);

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db); clock = now;
  // Re-point the fixture's generation at a MAINNET leader, paused until funded.
  const consent = { ...seed.consent, sourceNetwork: 'mainnet' as const };
  await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'mainnet' });
  await db.update(schema.copyLiveMandates).set({ sourceNetwork: 'mainnet', intent: consent, intentDigest: mandateDigest(consent) });
  await db.delete(schema.copyLiveSourceFills); await db.delete(schema.copyLiveSourceStreams);
  await db.update(schema.copyStrategies).set({ status: 'paused', pauseNewRisk: true });
  // The owner's approval leaves the generation awaiting its start.
  await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'pending', controlRevision: 0, requestedAt: new Date(now - 2000) });
  runtimeCalls.length = 0; settleCalls.length = 0; runtimeImpl = filled; settleImpl = async () => ({ kind: 'released' });
});
afterAll(async () => { await closeTestDb(); });

describe('testnet copy execution engine', () => {
  async function activeTestnetSource(longLived = false) {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'testnet' });
    const consent = longLived ? { ...seed.consent, expiresAt: now + 300_000 } : seed.consent;
    await db.update(schema.copyLiveMandates).set({ sourceNetwork: 'testnet', intent: consent, intentDigest: mandateDigest(consent), expiresAt: new Date(consent.expiresAt) });
    if (longLived) {
      await db.update(schema.copyWalletAuthorizations).set({ expiresAt: new Date(consent.expiresAt) });
      await db.update(schema.copyAgentSetups).set({ expiresAt: new Date(consent.expiresAt) });
    }
  }

  it.each([
    { reason: 'local_budget' as const, retryMs: 1500, dueMs: 1500 },
    { reason: 'local_budget' as const, retryMs: 0, dueMs: 1000 },
    { reason: 'shared_capacity' as const, retryMs: 65_000, dueMs: 65_000 },
    { reason: 'shared_capacity' as const, retryMs: 1500, dueMs: 65_000 },
  ])('retries a zero-read $reason admission ($retryMs ms) at its safe deadline, then retains the successful poll cadence', async ({ reason, retryMs, dueMs }) => {
    await activeTestnetSource(true);
    let firstAdmission = true;
    const budget = async () => {
      if (firstAdmission) { firstAdmission = false; throw new HyperliquidBudgetWait(retryMs, reason); }
    };
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json([]));
    const source = new HyperliquidLiveSourceClient('testnet', budget, fetcher as typeof fetch, () => clock);
    const run = engine({ testnetSource: source });
    await run.pollTestnetSources();
    expect(fetcher).not.toHaveBeenCalled();
    const sourceRow = async () => (await db.select().from(schema.copyLiveSourceStreams).where(eq(schema.copyLiveSourceStreams.id, `testnet:${leader}`)))[0]!;
    expect((await sourceRow()).coverageThrough).toBeNull();
    clock += dueMs - 1;
    await run.pollTestnetSources();
    expect(fetcher).not.toHaveBeenCalled();
    clock++;
    await run.pollTestnetSources();
    expect((await sourceRow()).coverageThrough?.getTime()).toBe(now + dueMs);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const requests = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.map(r => r.type)).toEqual(['userFillsByTime', 'userTwapSliceFillsByTime']);
    expect(requests.every(r => r.user === leader && r.endTime === now + dueMs)).toBe(true);
    clock += 59_999;
    await run.pollTestnetSources();
    expect(fetcher).toHaveBeenCalledTimes(2);
    clock++;
    await run.pollTestnetSources();
    expect((await sourceRow()).coverageThrough?.getTime()).toBe(now + dueMs + 60_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(runtimeCalls).toHaveLength(0);
  });

  // Gate run 9 (2026-10-14): one refused read waited the whole 60 s interval
  // and the ETH copy expired. A failed read is retried after 5 s, doubling
  // per failure in a row, never later than the interval; a good read resets it.
  it('retries a failed provider read sooner, backed off up to the poll interval', async () => {
    await activeTestnetSource(true);
    let status = 503;
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json(status === 200 ? [] : {}, { status }));
    const source = new HyperliquidLiveSourceClient('testnet', async () => {}, fetcher as typeof fetch, () => clock);
    // A 30 s interval, so the doubling reaches its cap inside the consent's 300 s.
    const run = engine({ testnetSource: source }, 30_000);
    await run.pollTestnetSources();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).type))
      .toEqual(['userFillsByTime', 'userTwapSliceFillsByTime']);
    let reads = 1;
    for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
      clock += delay - 1; await run.pollTestnetSources();
      expect(fetcher).toHaveBeenCalledTimes(2 * reads);
      clock++; await run.pollTestnetSources();
      expect(fetcher).toHaveBeenCalledTimes(2 * ++reads);
    }
    status = 200;
    clock += 30_000; await run.pollTestnetSources();
    expect(fetcher).toHaveBeenCalledTimes(2 * ++reads);
    status = 503;
    clock += 30_000; await run.pollTestnetSources();
    clock += 5_000; await run.pollTestnetSources();
    expect(fetcher).toHaveBeenCalledTimes(2 * (reads + 2));
    expect(runtimeCalls).toHaveLength(0);
  });

  it('retries 5 s after a read whose evidence the repository refused', async () => {
    await activeTestnetSource(true);
    const read = vi.fn(async (request: { leaderAddress: string; from: number; to: number }) => ({ network: 'testnet', leaderAddress: request.leaderAddress, from: request.from, to: request.to,
      observedAt: clock, completedAt: clock, fresh: true, complete: true, historicalCompleteness: 'unproven', requestsUsed: 1, fills: [], observations: [], unresolved: [], sourceDigest: 'forged' }));
    const logs: string[] = [];
    const run = engine({ testnetSource: { read } as never, log: message => logs.push(message) });
    await run.pollTestnetSources();
    expect(logs.some(line => line.includes('not read: invalid_live_source_evidence {"check":"source_digest"}'))).toBe(true);
    clock += 4_999; await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(1);
    clock++; await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('clears an admission retry override when its next provider read fails', async () => {
    await activeTestnetSource(true);
    let firstAdmission = true;
    const source = new HyperliquidLiveSourceClient('testnet', async () => {
      if (firstAdmission) { firstAdmission = false; throw new HyperliquidBudgetWait(1500, 'local_budget'); }
    }, (async () => Response.json({}, { status: 503 })) as typeof fetch, () => clock);
    const read = vi.spyOn(source, 'read');
    const run = engine({ testnetSource: source });
    await run.pollTestnetSources();
    clock += 1500; await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(2);
    clock += 4_999; await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(2);
    clock++; await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('polls active testnet source evidence without executing, settling, activating or driving setups', async () => {
    await activeTestnetSource();
    const read = vi.fn(async () => null);
    const setups = { tick: vi.fn(async () => 0) }, stopper = { tick: vi.fn(async () => {}) };
    const run = engine({ testnetSource: { read } as never, setups, stopper });
    await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(1);
    expect(runtimeCalls).toHaveLength(0); expect(settleCalls).toHaveLength(0);
    expect(setups.tick).not.toHaveBeenCalled(); expect(stopper.tick).not.toHaveBeenCalled();
    expect(await dispatches()).toHaveLength(0);
  });

  it('shares a testnet stream in-flight guard between the source poll and ordinary ingestion, releasing it after failure', async () => {
    await activeTestnetSource();
    let rejectRead!: (error: Error) => void;
    const read = vi.fn(() => new Promise<never>((_, reject) => { rejectRead = reject; }));
    const run = engine({ testnetSource: { read } as never }, 3000);
    const pending = run.pollTestnetSources();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const repository = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    const mandates = await repository.mandates(clock);
    const stream = repository.streams(mandates).find(s => s.network === 'testnet')!;
    expect(await run.ingest(stream, mandates)).toBeNull();
    await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(1);
    rejectRead(new LiveBoundaryError('live_source_read_unavailable')); await pending;
    clock += 3001;
    read.mockImplementation(async () => null as never);
    await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(2);
    expect(runtimeCalls).toHaveLength(0);
  });

  it('does not poll a mainnet leader or an inactive mandate through the separate testnet path', async () => {
    const read = vi.fn(async () => null);
    const run = engine({ testnetSource: { read } as never });
    await run.pollTestnetSources();
    expect(read).not.toHaveBeenCalled();
    await activeTestnetSource();
    await db.update(schema.copyStrategies).set({ status: 'stopping' });
    await run.pollTestnetSources();
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps paused generations in shared-source cursor accounting while selecting only active streams', async () => {
    await activeTestnetSource();
    const repository = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    const [active] = await repository.mandates(clock);
    const paused = { ...active!, mandateId: 'paused-generation', strategyStatus: 'paused', cursor: new Date(now - 60_000) };
    vi.spyOn(repository, 'mandates').mockResolvedValue([active!, paused]);
    await db.insert(schema.copyLiveSourceStreams).values({ id: `testnet:${leader}`, network: 'testnet', leaderAddress: leader,
      state: 'ready', coverageFrom: new Date(now - 60_000), coverageThrough: new Date(now - 40_000), coverageDigest: 'a'.repeat(64) });
    const read = vi.fn(async (_request: { from: number }) => null);
    const run = engine({ repository, testnetSource: { read } as never });
    await run.pollTestnetSources();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0].from).toBe(now - 40_000 + 1);
    const [stream] = await db.select().from(schema.copyLiveSourceStreams).where(eq(schema.copyLiveSourceStreams.id, `testnet:${leader}`));
    expect(stream!.coverageThrough!.getTime()).toBe(now - 40_000);
  });
  it.each(['platform_paused', 'user_paused', 'strategy_paused', 'platform_reduce_only', 'user_reduce_only', 'strategy_reduce_only'])('terminates an unsent %s open once and permits the following reduction', async reason => {
    const run = engine(); await credit(); await coverage(now - 10_000, now + 5000); await run.tick();
    const initial = await leaderFill(901, now + 100, 'B', '1', '0');
    clock = now + 1000; await run.tick(); clock = now + 1500; await run.tick();
    expect((await dispatches()).find(r => r.sourceFillId === initial)?.state).toBe('settled');
    const add = await leaderFill(902, now + 1600, 'B', '1', '1');
    const reduce = await leaderFill(903, now + 1700, 'A', '0.5', '2');
    runtimeImpl = async (request, hooks) => {
      if (request.sourceFillId === add) { runtimeCalls.push(request); throw new LiveBoundaryError(reason); }
      return filled(request, hooks);
    };
    clock = now + 2000; await run.tick(); clock = now + 3000; await run.tick();
    expect((await dispatches()).find(r => r.sourceFillId === add)).toMatchObject({ state: 'refused', reason, attempts: 1 });
    expect(runtimeCalls.filter(r => r.sourceFillId === add)).toHaveLength(1);
    expect(runtimeCalls.some(r => r.sourceFillId === reduce && r.leg === 'close')).toBe(true);
  });
  it('publishes an observation only after settlement, without reverting settled work when reporting fails', async () => {
    const published = vi.fn(async (_key: string) => { throw new Error('reporting unavailable'); });
    const run = engine({ settlementObservation: published } as Partial<LiveEngineDependencies>);
    await credit(); await coverage(now - 10_000, now + 5000); await run.tick();
    const first = await leaderFill(25, now + 100, 'B', '1', '0');
    clock = now + 1000; await run.tick();
    expect(published).not.toHaveBeenCalled();
    settleImpl = async () => ({ kind: 'pending', reason: 'live_settlement_terminal_unproven' });
    clock = now + 2000; await run.tick();
    expect(published).not.toHaveBeenCalled();
    settleImpl = async () => ({ kind: 'released' });
    clock = now + 3000; await run.tick();
    expect(published).toHaveBeenCalledExactlyOnceWith(keyOf(first, 'open'));
    expect((await dispatches())[0]).toMatchObject({ state: 'settled', attempts: 1, reason: null });
    clock = now + 4000; await run.tick();
    expect(runtimeCalls).toHaveLength(1);
    expect(published).toHaveBeenCalledTimes(1);
  });

  it('starts a generation only once it is funded, and never copies fills from before the start', async () => {
    await coverage(now - 10_000, now); await leaderFill(1, now - 500, 'B', '1', '0');
    await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'paused', pauseNewRisk: true });
    expect(await db.select().from(schema.copyLiveActivations)).toMatchObject([{ state: 'pending', activatedAt: null }]);
    await credit(); clock = now + 1000; await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'active', pauseNewRisk: false });
    expect(await db.select().from(schema.copyLiveActivations)).toMatchObject([{ state: 'activated' }]);
    // The pre-activation fill was ingested but is not a signal for this copy.
    expect(await db.select().from(schema.copyLiveSourceFills)).toHaveLength(1);
    expect(await dispatches()).toHaveLength(0); expect(runtimeCalls).toHaveLength(0);
  });

  it('never starts a strategy that a control paused after approval, nor one without a pending start', async () => {
    await credit(); await coverage(now - 10_000, now);
    // A strategy-level pause (as the admin's control command does) advances the control revision.
    await db.update(schema.copyStrategies).set({ pauseNewRisk: true, controlRevision: 1 });
    await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'paused', pauseNewRisk: true });
    await db.update(schema.copyStrategies).set({ controlRevision: 0 });
    for (const scope of ['platform', 'user'] as const) {
      await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, scope));
      await engine().tick();
      expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'paused' });
      await db.update(schema.copyControls).set({ pauseNewRisk: false }).where(eq(schema.copyControls.scope, scope));
    }
    await db.delete(schema.copyLiveActivations); await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'paused' });
    await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'pending', controlRevision: 0, requestedAt: new Date(now - 2000) });
    await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'active', pauseNewRisk: false, controlRevision: 1 });
    expect((await db.select().from(schema.copyLiveActivations))[0]).toMatchObject({ state: 'activated' });
  });

  it('a stale pass cannot move a work row out of a terminal state', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(10, now + 100, 'B', '1', '0');
    clock = now + 1000; await engine().tick();
    const repository = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), [row] = await dispatches();
    await db.update(schema.copyLiveDispatches).set({ state: 'settled', settledAt: new Date(clock) });
    expect(await repository.update({ ...row!, state: 'submitted' }, { state: 'refused', reason: 'late_writer' })).toBe(false);
    expect(await repository.update({ ...row!, state: 'pending' }, { attempts: 99 })).toBe(false);
    expect((await dispatches())[0]).toMatchObject({ sourceFillId: fill, state: 'settled', reason: null });
  });

  it('two passes that read the same attempt cannot both count it, nor overwrite each other\'s reason', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    await leaderFill(11, now + 100, 'B', '1', '0');
    clock = now + 1000; await engine().tick();
    const repository = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    await db.update(schema.copyLiveDispatches).set({ state: 'pending', attempts: 1, reason: 'exchange_busy' });
    const [read] = await dispatches();
    expect(await repository.update(read!, { attempts: read!.attempts + 1, reason: 'exchange_timeout' })).toBe(true);
    // The second pass still holds the row as it was before the first wrote.
    expect(await repository.update(read!, { attempts: read!.attempts + 1, reason: 'exchange_busy' })).toBe(false);
    expect((await dispatches())[0]).toMatchObject({ state: 'pending', attempts: 2, reason: 'exchange_timeout' });
    // A pass that read the row after the first write moves it on.
    const [fresh] = await dispatches();
    expect(await repository.update(fresh!, { attempts: fresh!.attempts + 1, reason: null })).toBe(true);
    expect((await dispatches())[0]).toMatchObject({ attempts: 3, reason: null });
  });

  it('ingests only the span the watcher proved, then mirrors each new leg once with its latency timings', async () => {
    await credit(); await coverage(now - 10_000, now); await engine().tick();
    const fill = await leaderFill(2, now + 500, 'B', '1', '0');
    clock = now + 1000; await engine().tick();
    expect(await dispatches()).toHaveLength(0); // coverage still ends at `now`
    await coverage(now - 10_000, now + 900); clock = now + 1200; await engine().tick();
    const stream = (await db.select().from(schema.copyLiveSourceStreams))[0]!;
    expect(stream).toMatchObject({ network: 'mainnet', state: 'ready' });
    expect(stream.coverageThrough!.getTime()).toBe(now + 900);
    const [row] = await dispatches();
    expect(row).toMatchObject({ sourceFillId: fill, leg: 'open', state: 'submitted', attempts: 1, executionKey: keyOf(fill, 'open') });
    expect(row!.leaderTime.getTime()).toBe(now + 500); expect(row!.sentAt!.getTime()).toBe(clock + 10); expect(row!.ackedAt!.getTime()).toBe(clock + 40);
    expect(runtimeCalls).toEqual([{ userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: fill, leg: 'open', signalDeadline: expect.any(Number) }]);
    clock += 3000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'settled' }); expect(settleCalls).toHaveLength(1);
    clock += 3000; await engine().tick();
    expect(runtimeCalls).toHaveLength(1); expect(settleCalls).toHaveLength(1);
  });

  it('waits for a prior never-placed release, on its coin and on another, without spending a new attempt', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const first = await leaderFill(20, now + 100, 'B', '1', '0');
    runtimeImpl = async (request, hooks) => {
      if (request.sourceFillId !== first) return filled(request, hooks);
      runtimeCalls.push(request);
      const key = keyOf(first, 'open');
      await journal(key, 'rejected');
      await db.update(schema.copyLiveExecutions).set({ record: { key, state: 'rejected', errorCode: NEVER_PLACED } }).where(eq(schema.copyLiveExecutions.key, key));
      return { key, state: 'rejected', errorCode: NEVER_PLACED } as LiveExecutionRecord;
    };
    clock = now + 1000; await engine().tick();
    const next = await leaderFill(21, now + 1100, 'B', '1', '1');
    const other = await leaderFill(22, now + 1200, 'B', '1', '0', 'ETH');
    settleImpl = async () => ({ kind: 'pending', reason: 'live_settlement_terminal_unproven' });
    clock = now + 2000; await engine().tick();
    // The other coin waits too: until the never-placed order is released,
    // every other order's generation proof refuses (gate run 10).
    expect(runtimeCalls.map(c => c.sourceFillId)).toEqual([first]);
    expect((await dispatches()).find(r => r.sourceFillId === next)).toMatchObject({ state: 'pending', attempts: 0, reason: null });
    expect((await dispatches()).find(r => r.sourceFillId === other)).toMatchObject({ state: 'pending', attempts: 0, reason: null });
    expect(settleCalls.map(c => c.key)).toContain(keyOf(first, 'open'));
    settleImpl = async request => request.key === keyOf(first, 'open') ? { kind: 'unplaced' } : { kind: 'released' };
    clock = now + 3000; await engine().tick();
    expect(runtimeCalls.map(c => c.sourceFillId).sort()).toEqual([first, other, next].sort());
    expect((await dispatches()).find(r => r.sourceFillId === first)).toMatchObject({ state: 'refused', reason: NEVER_PLACED });
    expect((await dispatches()).find(r => r.sourceFillId === next)).toMatchObject({ state: 'submitted', attempts: 1 });
  });

  describe('a leg whose order was released as never sent (its request never began)', () => {
    const keyAt = (fill: string, attempt: number) => `testnet:${seed.f.identity.accountAddress}:${liveSourceExecutionCloid('mandate', fill, 'open', attempt)}`;
    /** The runtime double: the attempts in `unsent` end rejected, never sent; the others fill. */
    function attempts(unsent: ReadonlySet<number>): Runtime {
      return async (request, hooks) => {
        const attempt = request.attempt ?? 0;
        if (!unsent.has(attempt)) {
          runtimeCalls.push(request);
          hooks.onExchange?.({ phase: 'request', at: clock + 10 });
          await journal(keyAt(request.sourceFillId, attempt), 'filled');
          return { key: keyAt(request.sourceFillId, attempt), state: 'filled' } as LiveExecutionRecord;
        }
        runtimeCalls.push(request);
        const key = keyAt(request.sourceFillId, attempt), record = { key, state: 'rejected', errorCode: NEVER_PLACED, unsent: 'request_never_began' };
        await journal(key, 'rejected');
        await db.update(schema.copyLiveExecutions).set({ record }).where(eq(schema.copyLiveExecutions.key, key));
        return record as LiveExecutionRecord;
      };
    }
    const unsentSettle = async (): Promise<LiveSettleOutcome> => ({ kind: 'unplaced', unsent: true });
    it('plans the leg again under the next attempt key at once, and that order is placed', async () => {
      await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
      const fill = await leaderFill(30, now + 100, 'B', '1', '0');
      runtimeImpl = attempts(new Set([0]));
      settleImpl = async request => request.key === keyAt(fill, 0) ? unsentSettle() : { kind: 'released' };
      clock = now + 1000; await engine().tick();
      expect((await dispatches())[0]).toMatchObject({ state: 'submitted', executionKey: keyAt(fill, 0) });
      // The next pass settles it (released at once) and plans attempt 1.
      clock = now + 1500; await engine().tick();
      expect((await dispatches())[0]).toMatchObject({ state: 'pending', executionKey: keyAt(fill, 0), reason: 'unsent_retry' });
      clock = now + 2000; await engine().tick();
      expect(runtimeCalls.map(c => c.attempt)).toEqual([undefined, 1]);
      expect(runtimeCalls[1]).toMatchObject({ sourceFillId: fill, leg: 'open', attempt: 1, signalDeadline: expect.any(Number) });
      expect((await dispatches())[0]).toMatchObject({ state: 'submitted', executionKey: keyAt(fill, 1), reason: null });
      clock = now + 2500; await engine().tick();
      expect((await dispatches())[0]).toMatchObject({ state: 'settled', executionKey: keyAt(fill, 1) });
      expect(settleCalls.map(c => c.key)).toEqual([keyAt(fill, 0), keyAt(fill, 1)]);
    });
    it(`makes at most ${MAX_LIVE_LEG_ATTEMPTS} attempts, then refuses the leg as before`, async () => {
      await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
      const fill = await leaderFill(31, now + 100, 'B', '1', '0');
      runtimeImpl = attempts(new Set([0, 1, 2, 3]));
      settleImpl = unsentSettle;
      for (let at = now + 1000; at <= now + 9000; at += 500) { clock = at; await engine().tick(); }
      expect(runtimeCalls.map(c => c.attempt)).toEqual([undefined, 1, 2]);
      expect((await dispatches())[0]).toMatchObject({ state: 'refused', reason: NEVER_PLACED, executionKey: keyAt(fill, MAX_LIVE_LEG_ATTEMPTS - 1) });
    });
    it('plans the next attempt after the API\'s testnet settlement released the order as never sent', async () => {
      await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
      const fill = await leaderFill(33, now + 100, 'B', '1', '0');
      runtimeImpl = attempts(new Set([0]));
      const api = () => engine({ apiTerminalSettlement: true });
      clock = now + 1000; await api().tick();
      clock = now + 1500; await api().tick();
      expect((await dispatches())[0]).toMatchObject({ state: 'submitted', executionKey: keyAt(fill, 0), reason: null });
      await new CopyLiveApiSettlementRepository(db).finish((await dispatches())[0]!, { kind: 'unplaced', unsent: true });
      expect((await dispatches())[0]).toMatchObject({ state: 'submitted', reason: 'unsent_released' });
      clock = now + 2000; await api().tick();
      clock = now + 2500; await api().tick();
      expect(settleCalls).toHaveLength(0);
      expect(runtimeCalls.map(c => c.attempt)).toEqual([undefined, 1]);
      expect((await dispatches())[0]).toMatchObject({ state: 'submitted', executionKey: keyAt(fill, 1) });
    });
    it('does not plan an open again once its signal is older than the policy allows', async () => {
      await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
      const fill = await leaderFill(32, now + 100, 'B', '1', '0');
      runtimeImpl = attempts(new Set([0])); settleImpl = unsentSettle;
      clock = now + 1000; await engine().tick();
      const limit = await new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()).signalAgeLimitMs();
      clock = now + 100 + limit + 1; await engine().tick();
      expect((await dispatches())[0]).toMatchObject({ state: 'refused', reason: NEVER_PLACED });
      expect(runtimeCalls.map(c => c.attempt)).toEqual([undefined]);
      expect(fill).toBeDefined();
    });
  });

  it('waits for a filled prior order whose risk reservation is still unknown before attempting the next same-coin leg', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const first = await leaderFill(23, now + 100, 'B', '1', '0');
    clock = now + 1000; await engine().tick();
    const f = seed.f, intent = { ...f.intent, cloid: liveSourceExecutionCloid('mandate', first, 'open') };
    const payload = planLiveReservation({ now: clock, identity: f.identity, localSource: f.localSource, intent,
      action: buildOrderAction(intent), market: f.market, quote: f.quote, leverage: f.leverageProofs[0]!, fees: f.fees,
      policy: f.policy, expiresAt: clock + 60_000 });
    await db.insert(schema.copyLiveRiskReservations).values({ ...payload, cloid: intent.cloid, coin: intent.market!.coin,
      dex: intent.market!.dex, asset: intent.asset, payload: payload as unknown as Record<string, unknown>, state: 'unknown',
      attemptedAt: new Date(clock), createdAt: new Date(payload.createdAt), expiresAt: new Date(payload.expiresAt), updatedAt: new Date(clock) });
    const next = await leaderFill(24, now + 1100, 'A', '0.5', '1');
    settleImpl = async () => ({ kind: 'pending', reason: 'live_settlement_terminal_unproven' });
    clock = now + 2000; await engine().tick();
    expect(runtimeCalls.map(c => c.sourceFillId)).toEqual([first]);
    expect((await dispatches()).find(r => r.sourceFillId === next)).toMatchObject({ state: 'pending', attempts: 0, reason: null });
    expect(settleCalls.map(c => c.key)).toContain(keyOf(first, 'open'));
    // This isolated SQL test doubles settlement; actual release proof is tested by the settler suites.
    settleImpl = async () => {
      await db.update(schema.copyLiveRiskReservations).set({ state: 'released', releaseReason: 'verified_settlement',
        releaseEvidenceDigest: 'a'.repeat(64), revision: 2, updatedAt: new Date(clock) }).where(eq(schema.copyLiveRiskReservations.key, payload.key));
      return { kind: 'released' };
    };
    clock = now + 3000; await engine().tick();
    expect(runtimeCalls.map(c => c.sourceFillId)).toEqual([first, next]);
    expect((await dispatches()).find(r => r.sourceFillId === first)).toMatchObject({ state: 'settled', attempts: 1 });
    expect((await dispatches()).find(r => r.sourceFillId === next)).toMatchObject({ state: 'submitted', attempts: 1 });
  });

  // Gate run 10 (2026-10-14): ETH's open was attempted six times while BTC's
  // filled order waited for its settlement; two attempts were refused by the
  // generation proof (every other journal must be settled), the others spent
  // their evidence, sockets and the user's risk lock beside BTC's settlement.
  it('waits for another coin\'s filled order to settle before attempting a leg, spending no attempt and no evidence', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const btc = await leaderFill(25, now + 100, 'B', '1', '0');
    clock = now + 1000; await engine().tick();
    const f = seed.f, intent = { ...f.intent, cloid: liveSourceExecutionCloid('mandate', btc, 'open') };
    const payload = planLiveReservation({ now: clock, identity: f.identity, localSource: f.localSource, intent,
      action: buildOrderAction(intent), market: f.market, quote: f.quote, leverage: f.leverageProofs[0]!, fees: f.fees,
      policy: f.policy, expiresAt: clock + 60_000 });
    await db.insert(schema.copyLiveRiskReservations).values({ ...payload, cloid: intent.cloid, coin: intent.market!.coin,
      dex: intent.market!.dex, asset: intent.asset, payload: payload as unknown as Record<string, unknown>, state: 'unknown',
      attemptedAt: new Date(clock), createdAt: new Date(payload.createdAt), expiresAt: new Date(payload.expiresAt), updatedAt: new Date(clock) });
    const eth = await leaderFill(26, now + 1100, 'B', '1', '0', 'ETH');
    settleImpl = async () => ({ kind: 'pending', reason: 'live_settlement_terminal_unproven' });
    clock = now + 2000; await engine().tick();
    clock = now + 2500; await engine().tick();
    expect(runtimeCalls.map(c => c.sourceFillId)).toEqual([btc]);
    expect((await dispatches()).find(r => r.sourceFillId === eth)).toMatchObject({ state: 'pending', attempts: 0, reason: null });
    settleImpl = async () => {
      await db.update(schema.copyLiveRiskReservations).set({ state: 'released', releaseReason: 'verified_settlement',
        releaseEvidenceDigest: 'a'.repeat(64), revision: 2, updatedAt: new Date(clock) }).where(eq(schema.copyLiveRiskReservations.key, payload.key));
      return { kind: 'released' };
    };
    // The pass settles BTC after it looked at ETH (pending legs first); ETH goes next pass.
    clock = now + 3000; await engine().tick();
    clock = now + 3500; await engine().tick();
    expect(runtimeCalls.map(c => c.sourceFillId)).toEqual([btc, eth]);
    expect((await dispatches()).find(r => r.sourceFillId === btc)).toMatchObject({ state: 'settled', attempts: 1 });
    expect((await dispatches()).find(r => r.sourceFillId === eth)).toMatchObject({ state: 'submitted', attempts: 1 });
  });

  it('refuses a price-deviation open for good but retries a transient refusal until the signal is too old', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const deviating = await leaderFill(3, now + 100, 'B', '1', '0', 'BTC'), transient = await leaderFill(4, now + 200, 'B', '1', '0', 'ETH');
    runtimeImpl = async request => { runtimeCalls.push(request); throw new LiveBoundaryError(request.sourceFillId === deviating ? 'live_source_price_deviation' : 'live_risk_stale'); };
    clock = now + 1000; await engine().tick();
    let rows = await dispatches();
    expect(rows.find(r => r.sourceFillId === deviating)).toMatchObject({ state: 'refused', reason: 'live_source_price_deviation', attempts: 1 });
    expect(rows.find(r => r.sourceFillId === transient)).toMatchObject({ state: 'pending', reason: 'live_risk_stale', attempts: 1 });
    clock = now + 2000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === transient)).toMatchObject({ state: 'pending', attempts: 2 });
    clock = now + 200 + 120_001; await engine().tick();
    rows = await dispatches();
    // Refused for its signal's age, not for its last failure (live_risk_stale goes to the log).
    expect(rows.find(r => r.sourceFillId === transient)).toMatchObject({ state: 'refused', reason: 'signal_expired', attempts: 2 });
    expect(runtimeCalls.filter(c => c.sourceFillId === deviating)).toHaveLength(1);
  });

  it('refuses an open for good once the runtime could not bring the leverage under the cap, never retrying it', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const above = await leaderFill(13, now + 100, 'B', '1', '0', 'BTC'), rejected = await leaderFill(14, now + 200, 'B', '1', '0', 'ETH');
    runtimeImpl = async request => { runtimeCalls.push(request); throw new LiveBoundaryError(request.sourceFillId === above ? 'live_risk_leverage' : 'live_leverage_update_rejected'); };
    clock = now + 1000; await engine().tick(); clock = now + 2000; await engine().tick();
    const rows = await dispatches();
    expect(rows.find(r => r.sourceFillId === above)).toMatchObject({ state: 'refused', reason: 'live_risk_leverage', attempts: 1 });
    expect(rows.find(r => r.sourceFillId === rejected)).toMatchObject({ state: 'refused', reason: 'live_leverage_update_rejected', attempts: 1 });
    expect(runtimeCalls).toHaveLength(2);
  });

  it('refuses an open for good when the account cannot hold the margin of another position set down (O8b), never retrying it', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const short = await leaderFill(13, now + 100, 'B', '1', '0', 'BTC');
    runtimeImpl = async request => { runtimeCalls.push(request); throw new LiveBoundaryError('live_risk_leverage_margin'); };
    clock = now + 1000; await engine().tick(); clock = now + 5000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === short)).toMatchObject({ state: 'refused', reason: 'live_risk_leverage_margin', attempts: 1 });
    expect(runtimeCalls).toHaveLength(1);
  });

  it('refuses a leg whose journal was rejected before its hold (never sent), instead of waiting on a settlement forever', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(15, now + 100, 'B', '1', '0');
    runtimeImpl = async request => { runtimeCalls.push(request); await journal(keyOf(fill, 'open'), 'rejected'); throw new LiveBoundaryError('available_collateral'); };
    settleImpl = async () => ({ kind: 'unsent', reason: 'available_collateral' });
    clock = now + 1000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'submitted', executionKey: keyOf(fill, 'open') });
    clock += 3000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'refused', reason: 'available_collateral' });
    expect(runtimeCalls).toHaveLength(1);
  });

  it('sends a leader\'s close however late (CP-EXE-14-02), with no signal deadline, where an open that old is refused', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(16, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(17, now + 200, 'A', '1', '1', 'ETH');
    const late = await leaderFill(18, now + 300, 'B', '1', '0', 'BTC');
    runtimeImpl = async (request, hooks) => { if (request.sourceFillId === open) return filled(request, hooks); runtimeCalls.push(request); throw new LiveBoundaryError('live_risk_stale'); };
    clock = now + 1000; await engine().tick(); clock += 3000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'settled' });
    runtimeCalls.length = 0; runtimeImpl = filled;
    clock = now + 300 + 600_000; await engine().tick();
    const rows = await dispatches();
    expect(rows.find(r => r.sourceFillId === close)).toMatchObject({ state: 'submitted', executionKey: keyOf(close, 'close') });
    expect(rows.find(r => r.sourceFillId === late)).toMatchObject({ state: 'refused' });
    expect(runtimeCalls).toEqual([{ userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: close, leg: 'close' }]);
  });

  it("a wait that sent nothing (a busy risk lock, an observation the shared meter refused) is never an attempt, is retried when it said, and an open that outlives its signal is refused signal_expired (gate 2026-10-13 11:15)", async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(81, now + 100, 'B', '1', '0', 'BTC');
    // Attempts 1 and 2 of the gate: the follower observation's socket connect
    // refused by the shared meter (it said: in 4 s); attempt 3: the risk lock busy.
    const refusals = [unavailable(new HyperliquidRestCapacityError(4_000)), unavailable(new HyperliquidRestCapacityError(4_000)),
      new LiveRiskBusyError({ lock: 'account', holders: [{ kind: 'order', id: 'testnet:0xabc:0x01', heldMs: 11_800 }], sessions: [] })];
    runtimeImpl = async request => { runtimeCalls.push(request); throw refusals.shift() ?? new LiveBoundaryError('live_risk_busy'); };
    const worker = engine(), logs: string[] = [];
    (worker as unknown as { deps: { log?: (m: string) => void } }).deps.log = message => { logs.push(message); };
    clock = now + 1000; await worker.tick();
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'pending', reason: 'live_account_observation_unavailable', attempts: 0 });
    // Not before the meter said (4 s and its slack; before: 10 s, as a failed provider read).
    clock = now + 5000; await worker.tick();
    expect(runtimeCalls).toHaveLength(1);
    clock = now + 5300; await worker.tick();
    expect(runtimeCalls).toHaveLength(2);
    clock = now + 9600; await worker.tick();
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'pending', reason: 'live_risk_busy', attempts: 0 });
    // Gate run 9: the busy line names the lock and who held it, for how long.
    expect(logs.some(m => m.includes('failed: live_risk_busy;') &&
      m.includes('held by {"lock":"account","holders":[{"kind":"order","id":"testnet:0xabc:0x01","heldMs":11800}],"sessions":[]}'))).toBe(true);
    // A busy lock is tried again a second later.
    clock = now + 10_700; await worker.tick();
    expect(runtimeCalls).toHaveLength(4);
    // Past the signal age: refused for that, with the last wait in the log only.
    clock = now + 100 + 120_001; await worker.tick();
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'refused', reason: 'signal_expired', attempts: 0 });
    expect(logs.some(m => m.includes('refused: signal_expired') && m.includes('last live_risk_busy'))).toBe(true);
  });

  it('keeps one order\'s need free on the shared meter while a copy mirrors its leader: the standby is renewed every 10 s', async () => {
    const standby = vi.fn(async (mandates: readonly { activated: boolean; accountAddress: string }[]) => { void mandates; });
    // No copy running yet: nothing is kept.
    clock = now + 500; await engine({ standby }).tick();
    expect(standby).not.toHaveBeenCalled();
    await credit(); await coverage(now - 10_000, now + 5000);
    const worker = engine({ standby });
    clock = now + 1000; await worker.tick();
    expect(standby).toHaveBeenCalledTimes(1);
    // It is given the running generations, so it keeps their actual need (liveStandbyNeed), not the startup bound.
    expect(standby.mock.calls[0]![0]).toEqual(expect.arrayContaining([expect.objectContaining({ activated: true, accountAddress: expect.any(String) })]));
    clock = now + 6000; await worker.tick(); await worker.pollTestnetSources();
    expect(standby).toHaveBeenCalledTimes(1);
    clock = now + 11_000; await worker.tick();
    expect(standby).toHaveBeenCalledTimes(2);
  });

  it('a close at its attempt limit is not refused by a wait that sent nothing', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(83, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(84, now + 200, 'A', '1', '1', 'ETH');
    runtimeImpl = async (request, hooks) => { if (request.sourceFillId === open) return filled(request, hooks); runtimeCalls.push(request); throw new LiveBoundaryError('live_risk_busy'); };
    clock = now + 1000; await engine().tick();
    await db.update(schema.copyLiveDispatches).set({ attempts: CLOSE_ATTEMPT_LIMIT - 1 }).where(eq(schema.copyLiveDispatches.sourceFillId, close));
    clock = now + 1_000_000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === close)).toMatchObject({ state: 'pending', reason: 'live_risk_busy', attempts: CLOSE_ATTEMPT_LIMIT - 1 });
  });

  it('refuses a close that keeps failing after CLOSE_ATTEMPT_LIMIT attempts, never retrying it for ever', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(25, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(26, now + 200, 'A', '1', '1', 'ETH');
    runtimeImpl = async (request, hooks) => { if (request.sourceFillId === open) return filled(request, hooks); runtimeCalls.push(request); throw new LiveBoundaryError('live_risk_stale'); };
    clock = now + 1000; await engine().tick();
    await db.update(schema.copyLiveDispatches).set({ attempts: CLOSE_ATTEMPT_LIMIT - 1 }).where(eq(schema.copyLiveDispatches.sourceFillId, close));
    clock = now + 1_000_000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === close)).toMatchObject({ state: 'refused', reason: 'live_risk_stale', attempts: CLOSE_ATTEMPT_LIMIT });
  });

  it('ends a later close once fresh runtime evidence proves the follower already flat, without another retry', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(60, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(61, now + 200, 'A', '1', '1', 'ETH');
    runtimeImpl = async (request, hooks) => {
      if (request.sourceFillId === open) return filled(request, hooks);
      runtimeCalls.push(request); throw new LiveBoundaryError('no_follower_position');
    };
    const worker = engine();
    for (const offset of [1000, 2000, 3000]) { clock = now + offset; await worker.tick(); }
    expect((await dispatches()).find(r => r.sourceFillId === close)).toMatchObject({ state: 'refused', reason: 'no_follower_position', attempts: 1 });
    expect(runtimeCalls.filter(r => r.sourceFillId === close)).toHaveLength(1);
  });

  it('refuses a leader close as position_liquidated, never sending it, once Hyperliquid liquidated the copy (CP-EXE-16)', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(65, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(66, now + 300, 'A', '1', '1', 'ETH');
    // Between the copy's open and the leader's close, the exchange liquidated the copy's ETH.
    const address = seed.f.identity.accountAddress;
    await db.insert(schema.copyFollowerReceipts).values({ key: `testnet:${address}:900`, accountId: 'account', network: 'testnet', accountAddress: address, kind: 'fill',
      sourceId: '900', coin: 'ETH', providerTime: new Date(now + 200), digest: 'b'.repeat(64), attribution: 'account',
      record: { tid: '900', coin: 'ETH', raw: { tid: 900, coin: 'ETH', side: 'A', liquidation: { liquidatedUser: address, markPx: '1900', method: 'market' } } } });
    runtimeImpl = filled;
    clock = now + 1000; await engine().tick(); clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'settled' });
    expect((await dispatches()).find(r => r.sourceFillId === close)).toMatchObject({ state: 'refused', reason: 'position_liquidated', attempts: 0 });
    expect(runtimeCalls.filter(r => r.sourceFillId === close)).toHaveLength(0);
  });

  it('keeps an open with a no-position runtime reason retryable', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(62, now + 100, 'B', '1', '0', 'ETH');
    runtimeImpl = async request => { runtimeCalls.push(request); throw new LiveBoundaryError('no_follower_position'); };
    const worker = engine();
    // A failed attempt waits 3 s for its next (retryDelayMs).
    for (const offset of [1000, 2000, 4000]) { clock = now + offset; await worker.tick(); }
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'pending', attempts: 2 });
  });

  it('keeps an attempted close journal in reconciliation despite a no-position runtime reason', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(63, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(64, now + 200, 'A', '1', '1', 'ETH');
    runtimeImpl = async (request, hooks) => {
      if (request.sourceFillId === open) return filled(request, hooks);
      runtimeCalls.push(request); await journal(keyOf(close, 'close'), 'unknown');
      throw new LiveBoundaryError('no_follower_position');
    };
    const worker = engine();
    // A failed attempt waits 3 s for its next (retryDelayMs).
    for (const offset of [1000, 2000, 5000, 8000]) { clock = now + offset; await worker.tick(); }
    expect((await dispatches()).find(r => r.sourceFillId === close)).toMatchObject({ state: 'submitted', executionKey: keyOf(close, 'close') });
  });

  it('closes what the follower still holds once the leader is flat: a close settled owing part of it, or refused', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const btcOpen = await leaderFill(19, now + 100, 'B', '1', '0', 'BTC'), btcClose = await leaderFill(20, now + 200, 'A', '1', '1', 'BTC');
    const ethOpen = await leaderFill(21, now + 300, 'B', '1', '0', 'ETH'), ethClose = await leaderFill(22, now + 400, 'A', '1', '1', 'ETH');
    const solOpen = await leaderFill(23, now + 500, 'B', '1', '0', 'SOL'), solClose = await leaderFill(24, now + 600, 'A', '1', '1', 'SOL');
    runtimeImpl = async (request, hooks) => {
      if (request.sourceFillId === ethClose) { runtimeCalls.push(request); throw new LiveBoundaryError('below_min_notional'); }
      clock++; return filled(request, hooks); // one nonce per journal
    };
    clock = now + 1000; await engine().tick(); clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    // BTC: the IOC close left 0.4 unfilled (the settled carry); SOL: closed in full.
    await db.insert(schema.copyLiveReductionCarry).values([{ mandateId: 'mandate', coin: 'BTC', carry: '0.4', revision: 2, updatedAt: new Date(clock) },
      { mandateId: 'mandate', coin: 'SOL', carry: '0', revision: 2, updatedAt: new Date(clock) }]);
    const rows = await dispatches();
    for (const [fill, state] of [[btcOpen, 'settled'], [btcClose, 'settled'], [ethOpen, 'settled'], [ethClose, 'refused'], [solOpen, 'settled'], [solClose, 'settled']] as const)
      expect(rows.find(r => r.sourceFillId === fill)).toMatchObject({ state });
    clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    const closes = await db.select().from(schema.copyLiveManualCloses);
    expect(closes.map(c => c.coin).sort()).toEqual(['BTC', 'ETH']);
    expect(closes.every(c => c.state === 'requested' && c.accountId === 'account' && c.idempotencyKey.startsWith('reconcile:'))).toBe(true);
  });

  it('skips a close of a position this copy never opened and orders a flip: close settles before the open is sent', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const orphanClose = await leaderFill(5, now + 100, 'A', '1', '2', 'ETH');
    const open = await leaderFill(6, now + 200, 'B', '2', '0');
    clock = now + 1000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === orphanClose)).toMatchObject({ state: 'refused', reason: 'no_follower_position' });
    // Leader flips long 2 → short 1: a close leg and an open leg.
    const flip = await leaderFill(7, now + 1500, 'A', '3', '2');
    settleImpl = async request => request.key === keyOf(flip, 'close') ? { kind: 'pending', reason: 'live_settlement_terminal_unproven' } : { kind: 'released' };
    clock = now + 2000; await engine().tick();
    let rows = (await dispatches()).filter(r => r.sourceFillId === flip);
    expect(rows.find(r => r.leg === 'close')).toMatchObject({ state: 'submitted' });
    expect(rows.find(r => r.leg === 'open')).toMatchObject({ state: 'pending', attempts: 0 });
    clock += 3000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === flip && r.leg === 'open')).toMatchObject({ state: 'pending', attempts: 0 });
    settleImpl = async () => ({ kind: 'released' });
    clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    rows = (await dispatches()).filter(r => r.sourceFillId === flip);
    expect(rows.find(r => r.leg === 'close')).toMatchObject({ state: 'settled' });
    expect(rows.find(r => r.leg === 'open')).toMatchObject({ state: 'settled' });
    const order = runtimeCalls.filter(c => c.sourceFillId === flip).map(c => c.leg);
    expect(order).toEqual(['close', 'open']);
    expect(runtimeCalls.some(c => c.sourceFillId === open)).toBe(true);
  });

  it('a flip of a side the leader opened before this copy: nothing to close, so the open is sent (never flip_close_not_settled)', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    // The leader was long 2 before activation and flips to short 1: the copy never held its long.
    const flip = await leaderFill(7, now + 100, 'A', '3', '2');
    clock = now + 1000; await engine().tick(); clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    const rows = (await dispatches()).filter(r => r.sourceFillId === flip);
    expect(rows.find(r => r.leg === 'close')).toMatchObject({ state: 'refused', reason: 'no_follower_position' });
    expect(rows.find(r => r.leg === 'open')).toMatchObject({ state: 'settled' });
    expect(runtimeCalls.filter(c => c.sourceFillId === flip).map(c => c.leg)).toEqual(['open']);
  });

  it('a flip whose close was refused for another reason still never sends its open', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(6, now + 100, 'B', '2', '0');
    clock = now + 1000; await engine().tick(); clock = now + 1200; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'settled' });
    const flip = await leaderFill(7, now + 1500, 'A', '3', '2');
    runtimeImpl = async (request, hooks) => { if (request.leg === 'close') { runtimeCalls.push(request); throw new LiveBoundaryError('live_market_unknown'); } return filled(request, hooks); };
    clock = now + 2000; await engine().tick(); clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    const rows = (await dispatches()).filter(r => r.sourceFillId === flip);
    expect(rows.find(r => r.leg === 'close')).toMatchObject({ state: 'refused', reason: 'live_market_unknown' });
    expect(rows.find(r => r.leg === 'open')).toMatchObject({ state: 'refused', reason: 'flip_close_not_settled' });
    expect(runtimeCalls.filter(c => c.sourceFillId === flip).every(c => c.leg === 'close')).toBe(true);
  });

  it('after a restart, an order left unknown is only reconciled; a journal found for a pending leg is never sent again', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(8, now + 100, 'B', '1', '0');
    // The previous worker died after the exchange boundary: journal `unknown`, row still pending.
    await engine().enqueue((await new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()).mandates(clock))[0]!);
    await journal(keyOf(fill, 'open'), 'unknown');
    runtimeImpl = async request => { runtimeCalls.push(request); return { key: keyOf(fill, 'open'), state: 'unknown' } as LiveExecutionRecord; };
    clock = now + 1000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'submitted', executionKey: keyOf(fill, 'open') });
    expect(runtimeCalls).toHaveLength(0); // the pass only adopted the journal
    clock += 3000; await engine().tick();
    expect(runtimeCalls).toHaveLength(1); // reconciliation through the runtime's existing-key path
    expect(settleCalls).toHaveLength(0);
    await journal(keyOf(fill, 'open'), 'partial'); clock += 3000; await engine().tick();
    expect(settleCalls).toHaveLength(1); expect((await dispatches())[0]).toMatchObject({ state: 'settled' });
  });

  it('a POST that began and then failed leaves the leg submitted for reconciliation, never pending', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(9, now + 100, 'B', '1', '0');
    runtimeImpl = async (request, hooks) => { runtimeCalls.push(request); hooks.onExchange?.({ phase: 'request', at: clock }); await journal(keyOf(fill, 'open'), 'unknown'); throw new LiveBoundaryError('exchange_submission_ambiguous'); };
    clock = now + 1000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'submitted', reason: 'exchange_submission_ambiguous', executionKey: keyOf(fill, 'open') });
    expect((await dispatches())[0]!.sentAt!.getTime()).toBe(clock);
  });

  it('audits nothing for a stream with no coverage yet, instead of failing (Stage 2026-10-12)', async () => {
    // Postgres greatest/least skip NULLs: the bounds came back null and the
    // audit threw a TypeError right after a copy started.
    await db.insert(schema.copyLiveSourceStreams).values({ id: `mainnet:${leader}`, network: 'mainnet', leaderAddress: leader, state: 'gap' });
    await coverage(now - 10_000, now + 500);
    await leaderFill(77, now - 5000, 'B', '1', '0');
    expect(await new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()).unmirroredFills(leader)).toEqual([]);
  });
  it('restarts a stale stream at the new cursor instead of reading the idle gap', async () => {
    await db.insert(schema.copyLiveSourceStreams).values({ id: `mainnet:${leader}`, network: 'mainnet', leaderAddress: leader, state: 'ready',
      coverageFrom: new Date(now - 900_000), coverageThrough: new Date(now - 800_000), coverageDigest: 'c'.repeat(64) });
    await coverage(now - 10_000, now + 500); clock = now + 1000; await engine().tick();
    const [stream] = await db.select().from(schema.copyLiveSourceStreams).where(eq(schema.copyLiveSourceStreams.id, `mainnet:${leader}`));
    expect(stream).toMatchObject({ state: 'ready' });
    expect(stream!.coverageFrom!.getTime()).toBe(now - 2000); // the mandate's activation cursor
    expect(stream!.coverageThrough!.getTime()).toBe(now + 500);
  });

  it('refuses a HIP-3 leg for good when it is enqueued, before any evidence read takes weight', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(12, now + 100, 'B', '1', '0', 'xyz:TSLA');
    clock = now + 1000; await engine().tick();
    expect(await dispatches()).toMatchObject([{ sourceFillId: fill, state: 'refused', reason: 'live_market_hip3_unsupported', attempts: 0 }]);
    expect(runtimeCalls).toHaveLength(0); // the runtime is what reads (and acquires) evidence
  });
});
