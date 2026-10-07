import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { copyLiveExecutions, copyLiveIntentProvenance, copyLivePositionBaselines, copyLiveReductionCarry, copyLiveSignalLegs, copySignerNonces,
  copyLiveMandates, copyStrategies, copyLiveSourceStreams, users } from '@trading-dashboard/shared/database';
import { PostgresLivePreparation } from '../src/copy/live/postgres-live-preparation.js';
import { LiveProviderReadEpoch } from '../src/copy/live/live-provider-read-epoch.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { canonicalLiveSourceLegs, liveSourceLegId } from '../src/copy/live/copy-live-source-evidence.js';
import { decodeLiveSourceSizingEnvelope } from '../src/copy/live/copy-live-source-planner.js';
import { ScopedLiveExecutionJournal } from '../src/copy/live/scoped-live-journal.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { getTestDb, closeTestDb, type TestDb } from './db-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';

let db: TestDb, pool: Pool, clock: number, scope: PostgresLiveRiskScope, seed: Awaited<ReturnType<typeof preparationFixture>>,
  observer: HyperliquidLiveAccountObserver, resolver: HyperliquidLiveMarketResolver, provider: HyperliquidLiveRiskProvider, preparation: PostgresLivePreparation;
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }); });
beforeEach(async () => {
  seed = await preparationFixture(db); clock = now; scope = new PostgresLiveRiskScope(pool, () => clock);
  const acquire = async () => {}, fetcher = vi.fn<typeof fetch>(async () => { throw Error('No real remote requests in fixtures'); });
  observer = new HyperliquidLiveAccountObserver('testnet', acquire, fetcher, () => clock);
  resolver = new HyperliquidLiveMarketResolver('testnet', acquire, fetcher, () => clock);
  provider = new HyperliquidLiveRiskProvider('testnet', acquire, fetcher, () => clock);
  vi.spyOn(observer, 'observe').mockResolvedValue(seed.f.accountSource.snapshot);
  vi.spyOn(resolver, 'resolve').mockResolvedValue(seed.f.market);
  vi.spyOn(provider, 'observe').mockResolvedValue({ network: 'testnet', accountAddress: seed.f.identity.accountAddress, coin: 'BTC', dex: '', asset: 0,
    market: seed.f.market, earliestObservedAt: now, completedAt: now, sourceDigest: 'a'.repeat(64), quote: seed.f.quote,
    leverageProofs: seed.f.leverageProofs, fees: seed.f.fees } as never);
  preparation = new PostgresLivePreparation(observer, resolver, provider, { slippageBps: '0', extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock);
});
afterAll(async () => { await pool.end(); await closeTestDb(); });
const identity = () => ({ userId: 1, network: 'testnet' as const, accountAddress: seed.f.identity.accountAddress, source: { network: 'testnet' as const, leaderAddress: seed.consent.leaderAddress } });
const binding = () => ({ accountId: 'account', mandateId: 'mandate', sourceFillId: seed.fill.id, leg: 'open' as const });
async function untouched() {
  for (const table of [copyLiveExecutions, copyLiveIntentProvenance, copyLivePositionBaselines, copyLiveReductionCarry, copyLiveSignalLegs]) expect(await db.select().from(table)).toHaveLength(0);
}
describe('atomic original-session live preparation', () => {
  it('waits for the original account observation cleanup before releasing the scope after an independent market failure', async () => {
    const epoch = new LiveProviderReadEpoch(observer, resolver, provider, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock);
    let release!: () => void, entered!: () => void;
    const accountPending = new Promise<void>(r => { release = r; }), accountEntered = new Promise<void>(r => { entered = r; });
    let ended = false, cleaned = false;
    vi.mocked(observer.observe).mockImplementation(async () => { entered(); await accountPending; cleaned = true; return seed.f.accountSource.snapshot; });
    vi.mocked(resolver.resolve).mockRejectedValue(Error('market unavailable'));
    const work = scope.run(identity(), async (_s, session) => epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: 'cleanup-frame', coin: 'BTC' }));
    void work.then(() => { ended = true; }, () => { ended = true; });
    await accountEntered;
    await new Promise(r => setTimeout(r, 30));
    const prematurelyEnded = ended;
    release(); await expect(work).rejects.toThrow('market unavailable');
    expect(cleaned).toBe(true); expect(prematurelyEnded).toBe(false);
  });
  it('starts independent target REST observations while the all-venue account subscription is still receiving', async () => {
    const epoch = new LiveProviderReadEpoch(observer, resolver, provider, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock);
    let accountReady!: () => void;
    const received = new Promise<void>(resolve => { accountReady = resolve; });
    let entered!: () => void, targetStarted!: () => void;
    const accountEntered = new Promise<void>(resolve => { entered = resolve; }), independentTarget = new Promise<true>(resolve => { targetStarted = () => resolve(true); });
    vi.mocked(observer.observe).mockImplementation(async () => { entered(); await received; return seed.f.accountSource.snapshot; });
    const original = await provider.observe(seed.f.identity.accountAddress, seed.f.market, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 });
    vi.mocked(provider.observe).mockImplementation(async () => { targetStarted(); return original; });
    const work = scope.run(identity(), async (_s, session) => {
      expect((await epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: 'parallel-read', coin: 'BTC' })).snapshots).toHaveLength(1);
    });
    await accountEntered;
    const independentlyCompleted = await Promise.race([independentTarget, new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    accountReady(); await work;
    expect(independentlyCompleted).toBe(true);
  });
  it('reuses original concrete provider frames across preparation and financial-boundary reads without changing their clocks', async () => {
    const epoch = new LiveProviderReadEpoch(observer, resolver, provider, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock);
    preparation = new PostgresLivePreparation(observer, resolver, provider, { slippageBps: '0', extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock, epoch);
    await scope.run(identity(), async (_s, session) => {
      const prepared = await preparation.prepare(session, binding());
      clock += 1;
      const first = await epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: prepared.record.key, coin: 'BTC' });
      clock += 1;
      const second = await epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: prepared.record.key, coin: 'BTC' });
      expect(second).toBe(first); expect(second.oldest).toBe(now);
      expect(second.snapshots[0]!.observedAt).toBe(now); expect(second.target.earliestObservedAt).toBe(now);
      expect(Object.isFrozen(second)).toBe(true); expect(Object.isFrozen(second.snapshots[0]!.coverage)).toBe(true);
    });
    expect(observer.observe).toHaveBeenCalledTimes(1); expect(resolver.resolve).toHaveBeenCalledTimes(1); expect(provider.observe).toHaveBeenCalledTimes(1);
  });
  it('cannot refresh an expired original epoch or import its frames into a successor session', async () => {
    const epoch = new LiveProviderReadEpoch(observer, resolver, provider, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock);
    const b = { accountId: 'account', mandateId: 'mandate', key: 'original-frame', coin: 'BTC' };
    let original: Parameters<typeof epoch.collect>[0];
    await scope.run(identity(), async (_s, session) => {
      original = session; await epoch.collect(session, b); clock += 5001; await session.scope.assertHeld();
      await expect(epoch.collect(session, b)).rejects.toThrow('live_risk_stale');
      expect(observer.observe).toHaveBeenCalledTimes(1);
    });
    await expect(epoch.collect(original!, b)).rejects.toThrow('live_risk_serialization_lost');
    clock = now;
    await scope.run(identity(), async (_s, session) => {
      await expect(epoch.collect({ ...session }, b)).rejects.toThrow('live_risk_serialization_lost');
      await epoch.collect(session, b);
    });
    expect(observer.observe).toHaveBeenCalledTimes(2);
  });
  it('checks current SQL authority before returning any retained provider frame', async () => {
    const epoch = new LiveProviderReadEpoch(observer, resolver, provider, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock);
    const b = { accountId: 'account', mandateId: 'mandate', key: 'original-frame', coin: 'BTC' };
    await scope.run(identity(), async (_s, session) => {
      await epoch.collect(session, b);
      await db.update(users).set({ privyUserId: 'did:privy:replacement' });
      await expect(epoch.collect(session, b)).rejects.toThrow('live_risk_identity');
    });
    expect(observer.observe).toHaveBeenCalledTimes(1);
  });
  it('never lets another execution identity adopt the same original epoch', async () => {
    const epoch = new LiveProviderReadEpoch(observer, resolver, provider, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock);
    await scope.run(identity(), async (_s, session) => {
      const b = { accountId: 'account', mandateId: 'mandate', key: 'original-frame', coin: 'BTC' };
      await epoch.collect(session, b);
      await expect(epoch.collect(session, { ...b, key: 'replacement-frame' })).rejects.toThrow('live_risk_epoch_mismatch');
      await expect(epoch.collect(session, { ...b, coin: 'ETH' })).rejects.toThrow('live_risk_epoch_mismatch');
    });
    expect(provider.observe).toHaveBeenCalledTimes(1);
  });
  it('commits canonical intent, nonce, fixed source claim, baseline and original observations on one connection', async () => {
    await scope.run(identity(), async (_s, session) => {
      const result = await preparation.prepare(session, binding());
      // The fixture's fixed 10 USD at the mid (no slippage): 0.1, at the exchange minimum.
      expect(result.intent).toMatchObject({ size: '0.1', side: 'B', reduceOnly: false, timeInForce: 'Ioc' });
      expect(await new ScopedLiveExecutionJournal(session, result.record.key).get(result.record.key)).toEqual(result.record);
      const [p] = await session.read(db => db.select().from(copyLiveIntentProvenance));
      expect(decodeLiveSourceSizingEnvelope(p!.sizingBasis).observations.follower.observedAt).toBe(now);
    });
    expect(await db.select().from(copyLivePositionBaselines)).toHaveLength(1);
    expect((await db.select().from(copyLiveSignalLegs))[0]).toMatchObject({ state: 'prepared', fixedTradeClaim: true, revision: 2 });
    expect((await db.select().from(copyLiveReductionCarry))[0]).toMatchObject({ carry: '0', revision: 1 });
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ allocated: '0', cash: '0' });
  });
  it('recovers the same original key and nonce without recollecting or repricing', async () => {
    const first = await scope.run(identity(), async (_s, session) => preparation.prepare(session, binding()));
    vi.mocked(observer.observe).mockClear(); vi.mocked(provider.observe).mockClear();
    const second = await scope.run(identity(), async (_s, session) => preparation.prepare(session, binding()));
    expect(second).toEqual(first); expect(observer.observe).not.toHaveBeenCalled(); expect(provider.observe).not.toHaveBeenCalled();
    expect(await db.select().from(copyLiveExecutions)).toHaveLength(1);
    expect((await db.select().from(copySignerNonces))[0]!.nonce).toBe(first.record.nonce);
  });
  it('rejects structural sessions before provider or SQL admission', async () => {
    await scope.run(identity(), async (_s, session) => { await expect(preparation.prepare({ ...session }, binding())).rejects.toThrow('live_risk_serialization_lost'); });
    await untouched(); expect(observer.observe).not.toHaveBeenCalled();
  });
  it('sequences ratio follower and leader reads on the exclusive concrete account source', async () => {
    seed = await preparationFixture(db, 'ratio');
    let busy = false;
    vi.mocked(observer.observe).mockImplementation(async accountAddress => {
      if (busy) throw Error('live_account_source_busy');
      busy = true; await Promise.resolve();
      const snapshot = structuredClone(seed.f.accountSource.snapshot);
      Object.assign(snapshot, { accountAddress }); busy = false;
      return snapshot;
    });
    await scope.run(identity(), async (_s, session) => {
      expect((await preparation.prepare(session, binding())).intent.size).toBe('1');
    });
    expect(observer.observe).toHaveBeenCalledTimes(2);
  });
  it('refuses stale completion after COMMIT while retaining the original prepared identity', async () => {
    const snapshot = structuredClone(seed.f.accountSource.snapshot);
    Object.assign(snapshot.coverage, { earliestProviderTime: now - 4999 }); Object.assign(snapshot.dexes[0]!, { providerTime: now - 4999 });
    vi.mocked(observer.observe).mockResolvedValue(snapshot);
    const client = await pool.connect(), original = client.query.bind(client);
    let inserted = false;
    const spy = vi.spyOn(client, 'query').mockImplementation((async (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
      const result = await (original as (...args: unknown[]) => Promise<unknown>)(...args);
      if (/^insert into "copy_live_intent_provenance"/i.test(text)) inserted = true;
      if (inserted && /^commit$/i.test(text)) { clock += 2; inserted = false; }
      return result;
    }) as never);
    client.release();
    try {
      await scope.run(identity(), async (_s, session) => { await expect(preparation.prepare(session, binding())).rejects.toThrow('live_risk_stale'); });
      expect(clock - now).toBe(2);
      expect(await db.select().from(copyLiveExecutions)).toHaveLength(1);
      expect(await db.select().from(copyLiveIntentProvenance)).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  it('rolls back all preparation writes when a provider delay crosses the original five seconds', async () => {
    vi.mocked(provider.observe).mockImplementation(async () => { clock += 5001; return {} as never; });
    await scope.run(identity(), async (_s, session) => { await expect(preparation.prepare(session, binding())).rejects.toThrow('live_risk_stale'); });
    await untouched();
  });
  it('rechecks current owner binding after observations and rejects drift without a partial journal', async () => {
    const proof = await provider.observe(seed.f.identity.accountAddress, seed.f.market, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 });
    vi.mocked(provider.observe).mockImplementation(async () => { await db.update(users).set({ privyUserId: 'did:privy:changed' }); return proof; });
    await scope.run(identity(), async (_s, session) => { await expect(preparation.prepare(session, binding())).rejects.toThrow('live_risk_identity'); });
    await untouched();
  });
  it('rolls back the source claim and baseline when the signer nonce is outside the safe clock window', async () => {
    await db.insert(copySignerNonces).values({ network: 'testnet', signerAddress: seed.consent.agentAddress, nonce: now + 30000 });
    await scope.run(identity(), async (_s, session) => { await expect(preparation.prepare(session, binding())).rejects.toThrow('nonce_clock_skew'); });
    await untouched(); expect((await db.select().from(copySignerNonces))[0]!.nonce).toBe(now + 30000);
  });
  it('does not adopt a nonempty actual account as a new empty generation', async () => {
    const snapshot = structuredClone(seed.f.accountSource.snapshot); Object.assign(snapshot, { exposureUsd: '1', totalMarginUsed: '1' });
    vi.mocked(observer.observe).mockResolvedValue(snapshot);
    await scope.run(identity(), async (_s, session) => { await expect(preparation.prepare(session, binding())).rejects.toThrow('live_risk_baseline_unproven'); });
    await untouched();
  });
  it('rejects preexisting contradictory source legs and rolls back its new nonce', async () => {
    const leg = canonicalLiveSourceLegs(seed.fill)[0]!;
    await db.insert(copyLiveSignalLegs).values({ ...leg, sign: -1, id: liveSourceLegId('mandate', seed.fill.id, 'open'), mandateId: 'mandate', sourceFillId: seed.fill.id, createdAt: new Date(now), updatedAt: new Date(now) });
    await scope.run(identity(), async (_s, session) => { await expect(preparation.prepare(session, binding())).rejects.toThrow('live_preparation_claim_conflict'); });
    expect(await db.select().from(copyLiveExecutions)).toHaveLength(0); expect(await db.select().from(copySignerNonces)).toHaveLength(0);
  });
  it.each(['mandate', 'source'] as const)('rejects %s drift before remote reads', async kind => {
    if (kind === 'mandate') await db.update(copyLiveMandates).set({ state: 'paused' }).where(eq(copyLiveMandates.id, 'mandate'));
    else await db.update(copyLiveSourceStreams).set({ state: 'gap' });
    await scope.run(identity(), async (_s, session) => { await expect(preparation.prepare(session, binding())).rejects.toThrow(); });
    await untouched(); expect(observer.observe).not.toHaveBeenCalled();
  });
});
