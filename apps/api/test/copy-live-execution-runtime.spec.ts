import { generateKeyPairSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { LiveExecutionRuntime, type LiveExecutionRequest } from '../src/copy/live/live-execution-runtime.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { getTestDb, closeTestDb, type TestDb } from './db-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import * as authority from '../src/copy/live/postgres-live-risk-authority.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { TypedDataDefinition } from 'viem';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceLegId, parseLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
import { planLiveSourceOrder } from '../src/copy/live/copy-live-source-planner.js';
import { copyRiskLimitsSchema, copyStrategySettingsSchema } from '@trading-dashboard/shared/contracts';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { LiveProviderReadEpoch } from '../src/copy/live/live-provider-read-epoch.js';
import { PostgresLiveReservations } from '../src/copy/live/postgres-live-reservations.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { BoundaryPrivyOrderSigningClient } from '../src/copy/live/privy-order-client.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { PostgresLiveUnattemptedRecovery } from '../src/copy/live/postgres-live-unattempted-recovery.js';
import { CopyWalletRepository } from '../src/copy/copy-wallet.repository.js';
import { CopyAgentRepository } from '../src/copy/copy-agent.repository.js';
import { UNHELD_REJECTED } from '../src/copy/live/live-execution.js';
import { registerLiveDeployment } from '../src/copy/live-deployment.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { CopyLiveSettler } from '../src/copy/live-worker/copy-live-settler.js';
import { PostgresLiveSettlement } from '../src/copy/live/postgres-live-settlement.js';
import { OBSERVER_REST_WEIGHT } from '../src/copy/live/live-account-observer.js';

// Native network endpoints alone are replaced. Every provider decoder, private
// quota capability, SQL authority and SDK request boundary remains concrete.
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; static CLOSED = 3; readyState = 1;
    constructor(readonly url: string, readonly options: unknown) { super(); }
    send(value: string) {
      const request = JSON.parse(value), subscription = request.subscription;
      queueMicrotask(() => {
        this.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
        if (request.method !== 'subscribe') return;
        const sums = { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' };
        const held = openPositions.length, value = String(5 * held), margin = String(0.5 * held);
        const totals = { accountValue: '100', totalNtlPos: value, totalRawUsd: '100', totalMarginUsed: margin };
        const state = held ? { marginSummary: totals, crossMarginSummary: totals, crossMaintenanceMarginUsed: '0.1', withdrawable: String(100 - 0.5 * held), time: clock,
          assetPositions: openPositions.map(coin => ({ type: 'oneWay', position: { coin, szi: '0.05', entryPx: '100', positionValue: '5', unrealizedPnl: '0', marginUsed: '0.5',
            maxLeverage: 20, leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } })) }
          : { marginSummary: sums, crossMarginSummary: sums, crossMaintenanceMarginUsed: '0', withdrawable: '100', time: clock, assetPositions: [] };
        this.emit('message', Buffer.from(JSON.stringify(subscription.type === 'allDexsClearinghouseState'
          ? { channel: subscription.type, data: { user: subscription.user, clearinghouseStates: [['', state]] } }
          : { channel: 'openOrders', data: { user: subscription.user, dex: subscription.dex, orders: [] } })));
      });
    }
    close(code: number) { this.readyState = 3; this.emit('close', code, Buffer.alloc(0)); }
    terminate() { this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)); }
  } };
});

/** Coins the follower already holds (the WebSocket account state). */
let openPositions: string[] = [];
const authorizationKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const options = { extraRiskBufferBps: '5', restingOrderBuilderFeeCapTenthsBps: 100, slippageBps: '30' };
let db: TestDb, pool: Pool, seed: Awaited<ReturnType<typeof preparationFixture>>, budget: RequestBudgeterService;
let raw: ReturnType<typeof vi.fn<typeof fetch>>, global: HyperliquidGlobalTransport, config: AppConfig, clock: number;
const agent = privateKeyToAccount(`0x${'11'.repeat(32)}`);
function configuration(extra: Record<string, string | undefined> = {}) {
  return new AppConfig(validateEnvironment({ DATABASE_URL: process.env.TEST_DATABASE_URL,
    HYPERLIQUID_EGRESS_KEY: 'runtime-test-shared-egress', HYPERLIQUID_NETWORK: 'testnet',
    PRIVY_APP_ID: 'offline-app', PRIVY_APP_SECRET: 'offline-secret',
    PRIVY_AGENT_AUTHORIZATION_KEY: authorizationKey, PRIVY_AGENT_WORKER_QUORUM_ID: 'worker',
    HYPERLIQUID_STARTUP_PACE_SECONDS: '0', HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: '200', HYPERLIQUID_WEIGHT_BURST: '1000', ...extra }));
}
const request = (): LiveExecutionRequest => ({ userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: seed.fill.id, leg: 'open' });
const runtime = (c = config, deployment = options) => new LiveExecutionRuntime('testnet', pool, c, global, budget, deployment, () => clock);
async function revokeHistoricalGrant() {
  const repository = new CopyWalletRepository(db);
  return db.transaction(async tx => {
    const row = await repository.lockedGrant(tx, 1, 'grant');
    expect(row).toBeDefined();
    const at = new Date(clock), grant = await repository.revokeGrant(tx, row!.grant.id, row!.grant.version + 1, at);
    await repository.recordRevocation(tx, { id: 'runtime-real-revoke', authorizationId: grant.id, userId: 1,
      version: grant.version, action: 'revoked', createdAt: at });
    return grant;
  });
}
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }); });
beforeEach(async () => {
  seed = await preparationFixture(db); await db.delete(schema.hyperliquidWsLeases); await db.delete(schema.hyperliquidEgressQuota);
  clock = now; config = configuration(); budget = new RequestBudgeterService(config);
  raw = vi.fn<typeof fetch>(async () => { throw Error('Unexpected real provider boundary'); });
  global = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))),
    { egressKey: config.value.hyperliquid.egressKey, ownerId: 'runtime-test' }, raw);
  vi.stubGlobal('fetch', raw);
});
afterEach(() => { budget.onModuleDestroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await pool.end(); await closeTestDb(); });
async function actualClockFixture(perTradeUsd: number | null = 10, accountRevision = 1, sizingMode?: 'ratio') {
  // Preserve original source timestamps/consent bindings, rather than restamp
  // proof objects. The genuine fixture is created at the provider/SQL clock.
  clock = Date.now(); const delta = clock - now, date = (value: number) => new Date(value + delta);
  const [version] = await db.select().from(schema.copyStrategyVersions);
  const settings = { ...version!.settings, perTradeUsd, ...(sizingMode ? { sizingMode } : {}) };
  await db.update(schema.copyStrategyVersions).set({ settings });
  if (accountRevision !== 1) await db.update(schema.copyExecutionAccounts).set({ revision: accountRevision });
  const consent = { ...seed.consent, accountRevision, settingsDigest: liveCopySettingsDigest(settings), agentAddress: agent.address.toLowerCase(), nonce: seed.consent.nonce + delta,
    consentExpiresAt: seed.consent.consentExpiresAt + delta, expiresAt: seed.consent.expiresAt + delta };
  await db.update(schema.copyWalletAuthorizations).set({ validFrom: date(now - 1), expiresAt: date(now + 60000), exchangeApprovedAt: date(now - 1) });
  await db.update(schema.copyExecutionWallets).set({ signerAddress: consent.agentAddress });
  await db.update(schema.copyAgentSetups).set({ agentAddress: consent.agentAddress, expiresAt: date(now + 60000), createdAt: date(now - 4000), updatedAt: date(now - 1) });
  await db.update(schema.copyLiveMandates).set({ accountRevision: consent.accountRevision, settingsDigest: consent.settingsDigest, agentAddress: consent.agentAddress, nonce: consent.nonce, intent: consent, intentDigest: mandateDigest(consent),
    consentExpiresAt: new Date(consent.consentExpiresAt), expiresAt: new Date(consent.expiresAt), activationCursor: date(now - 2000), createdAt: date(now - 3000), updatedAt: date(now - 2000) });
  await db.update(schema.copyLiveSourceStreams).set({ coverageFrom: date(now - 2000), coverageThrough: date(now) });
  const fill = parseLiveSourceFill({ ...seed.fill.raw, time: clock - 1000 }, { network: 'testnet', leaderAddress: consent.leaderAddress,
    from: clock - 2000, to: clock, receivedAt: clock, kind: 'fills' });
  await db.delete(schema.copyLiveSourceFills);
  await db.insert(schema.copyLiveSourceFills).values({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) });
  seed = { ...seed, consent, fill };
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE'];
  const meta = { collateralToken: 7, universe: coins.map(name => ({ name, szDecimals: 2, maxLeverage: 20 })) };
  raw.mockImplementation(async (url, init) => {
    const endpoint = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (endpoint === 'https://api.privy.io/v1/wallets/agent') return Response.json({ id: 'agent', chain_type: 'ethereum', address: agent.address, owner_id: 'owner', archived_at: null });
    if (endpoint === 'https://api.privy.io/v1/wallets/agent/rpc') {
      const typed = body.params.typed_data;
      const signature = await agent.signTypedData({ ...typed, primaryType: typed.primary_type } as TypedDataDefinition);
      return Response.json({ method: 'eth_signTypedData_v4', data: { encoding: 'hex', signature } });
    }
    if (endpoint === 'https://api.hyperliquid-testnet.xyz/exchange') return Response.json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 77, totalSz: body.action.orders[0].s, avgPx: '100' } }] } } });
    expect(endpoint).toBe('https://api.hyperliquid-testnet.xyz/info');
    const values: Record<string, unknown> = { userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false,
      spotClearinghouseState: { portfolioMarginEnabled: false, balances: [] }, perpDexs: [null], spotMeta: { tokens: [{ index: 7, name: 'USDC', isCanonical: true }] },
      meta, allPerpMetas: [meta], metaAndAssetCtxs: [meta, coins.map(() => ({ midPx: '100', markPx: '100' }))],
      activeAssetData: { user: body.user, coin: body.coin, leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['1', '1'], availableToTrade: ['100', '100'], markPx: '100' },
      userFees: { userAddRate: '-0.0001', userCrossRate: '0.0005', activeReferralDiscount: '0', trial: null },
      extraAgents: [{ address: agent.address, name: 'dedicated', validUntil: clock + 60000 }], orderStatus: { status: 'unknownOid' } };
    if (!(body.type in values)) throw Error(`Unsupported offline INFO ${body.type}`);
    return Response.json(values[body.type]);
  });
}
describe('unregistered concrete testnet execution runtime', () => {
  it('starts authorized wallet metadata before financial preparation provider reads', async () => {
    await actualClockFixture();
    const previous = raw.getMockImplementation()!;
    const order: string[] = [];
    raw.mockImplementation(async (url, init) => {
      const endpoint = String(url);
      if (endpoint === 'https://api.privy.io/v1/wallets/agent') order.push('wallet');
      if (endpoint === 'https://api.hyperliquid-testnet.xyz/info') order.push('evidence');
      return previous(url, init);
    });
    expect((await runtime(config, { ...options, slippageBps: '0' }).execute(request())).state).toBe('filled');
    expect(order[0]).toBe('wallet');
    expect(order.filter(value => value === 'wallet')).toHaveLength(1);
    expect(order).toContain('evidence');
  });
  it('drains unused wallet metadata after releasing financial SQL locks on preparation refusal', async () => {
    await actualClockFixture();
    const previous = raw.getMockImplementation()!;
    let locksAtCleanup: number | undefined, canceled = false;
    raw.mockImplementation(async (url, init) => {
      if (String(url) !== 'https://api.privy.io/v1/wallets/agent') return previous(url, init);
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
        setTimeout(() => {
          void db.execute(sql`select count(*)::int as n from pg_locks where locktype='advisory' and classid=7404 and objid=1
            and pid in (select pid from pg_stat_activity where datname=current_database())`)
            .then(rows => { locksAtCleanup = Number(rows.rows[0]!.n); canceled = true; reject(new Error('metadata canceled')); }, reject);
        }, 40);
      }, { once: true }));
    });
    // The original 10 USD + slippage fixture is below the required notional:
    // preparation must refuse, never create an order or retain its locks.
    await expect(runtime().execute(request())).rejects.toThrow('below_min_notional');
    expect(canceled).toBe(true); expect(locksAtCleanup).toBe(0);
    expect(raw.mock.calls.some(([url]) => String(url).endsWith('/rpc') || String(url).endsWith('/exchange'))).toBe(false);
  });
  it.each(['platform', 'user', 'strategy'] as const)('rejects a %s-paused new open before evidence quota or provider work', async scope => {
    if (scope === 'strategy') await db.update(schema.copyStrategies).set({ pauseNewRisk: true });
    else await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, scope));
    const acquire = vi.spyOn(budget, 'acquire').mockRejectedValue(new Error('quota unavailable before pause admission'));
    await expect(runtime().execute(request())).rejects.toThrow(`${scope}_paused`);
    expect(acquire).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
    expect(await db.select().from(schema.copyLiveRiskReservations)).toHaveLength(0);
    expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
  });
  it.each(['platform', 'user', 'strategy'] as const)('rejects a %s-reduce-only new open before evidence quota', async scope => {
    if (scope === 'strategy') await db.update(schema.copyStrategies).set({ reduceOnly: true });
    else await db.update(schema.copyControls).set({ reduceOnly: true }).where(eq(schema.copyControls.scope, scope));
    const acquire = vi.spyOn(budget, 'acquire').mockRejectedValue(new Error('quota unavailable before reduce-only admission'));
    await expect(runtime().execute(request())).rejects.toThrow(`${scope}_reduce_only`);
    expect(acquire).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
  it('revalidates current pause under locks instead of rejecting a resumed routing hint', async () => {
    await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, 'platform'));
    const run = PostgresLiveRiskScope.prototype.run;
    vi.spyOn(PostgresLiveRiskScope.prototype, 'run').mockImplementationOnce(async function(this: PostgresLiveRiskScope, identity, work) {
      await db.update(schema.copyControls).set({ pauseNewRisk: false }).where(eq(schema.copyControls.scope, 'platform'));
      return run.call(this, identity, work);
    });
    const acquire = vi.spyOn(budget, 'acquire').mockRejectedValue(new Error('resumed open waits for real quota'));
    await expect(runtime().execute(request())).rejects.toThrow('resumed open waits for real quota');
    expect(acquire).toHaveBeenCalledOnce(); expect(raw).not.toHaveBeenCalled();
  });
  it('does not treat a paused routing hint as authority for a disabled owner', async () => {
    await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, 'platform'));
    await db.update(schema.users).set({ disabledAt: new Date(now) }).where(eq(schema.users.id, 1));
    const acquire = vi.spyOn(budget, 'acquire');
    await expect(runtime().execute(request())).rejects.toThrow('live_risk_identity');
    expect(acquire).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it('keeps a real close out of opening-only admission even when paused', async () => {
    const fill = parseLiveSourceFill({ ...seed.fill.raw, side: 'A', dir: 'Close Long', startPosition: '1' },
      { network: 'testnet', leaderAddress: seed.consent.leaderAddress, from: now - 2000, to: now, receivedAt: now, kind: 'fills' });
    await db.delete(schema.copyLiveSourceFills);
    await db.insert(schema.copyLiveSourceFills).values({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) });
    await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, 'platform'));
    const acquire = vi.spyOn(budget, 'acquire').mockRejectedValue(new Error('reduction uses ordinary evidence quota'));
    await expect(runtime().execute({ ...request(), sourceFillId: fill.id, leg: 'close' })).rejects.toThrow('reduction uses ordinary evidence quota');
    expect(acquire).toHaveBeenCalledOnce(); expect(raw).not.toHaveBeenCalled();
  });
  it('retains an original terminal order under pause without reserving new evidence or signing again', async () => {
    await actualClockFixture(); const original = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, 'platform'));
    raw.mockClear(); const acquire = vi.spyOn(budget, 'acquire').mockRejectedValue(new Error('no new quota'));
    expect(await runtime().execute(request())).toEqual(original);
    expect(acquire).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it('denies an unconfigured project egress before routing SQL or provider work', async () => {
    config = configuration({ HYPERLIQUID_EGRESS_KEY: undefined });
    const connect = vi.spyOn(pool, 'connect');
    await expect(runtime().execute(request())).rejects.toThrow('hyperliquid_quota_egress_unconfigured');
    expect(connect).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it('rejects a structurally forged transport instead of accepting a caller gate or quota bypass', () => {
    expect(() => new LiveExecutionRuntime('testnet', pool, config, { ...global } as HyperliquidGlobalTransport,
      budget, options)).toThrow('live_runtime_dependencies');
  });
  it.each([{ slippageBps: '-1' }, { extraRiskBufferBps: 'NaN' }, { restingOrderBuilderFeeCapTenthsBps: 101 }])('rejects invalid deployment risk settings %j', patch => {
    expect(() => runtime(config, { ...options, ...patch })).toThrow('live_runtime_options');
  });
  it('rejects a foreign owner before any network observation or nonce allocation', async () => {
    await expect(runtime().execute({ ...request(), userId: 2 })).rejects.toThrow('live_runtime_identity');
    expect(raw).not.toHaveBeenCalled(); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
  });
  it('refuses mainnet configuration even though discovery and global quota support mainnet', async () => {
    await expect(runtime(configuration({ HYPERLIQUID_NETWORK: 'mainnet' })).execute(request())).rejects.toThrow('live_runtime_network');
    expect(raw).not.toHaveBeenCalled();
  });
  it('does not treat an expired mandate as admission authority', async () => {
    const expired = new LiveExecutionRuntime('testnet', pool, config, global, budget, options, () => now + 60001);
    await expect(expired.execute(request())).rejects.toThrow('live_risk_mandate_changed');
    expect(raw).not.toHaveBeenCalled(); expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
  it('rechecks a disabled owner under the original scope after routing lookup', async () => {
    const original = authority.loadLivePreparationAuthority;
    vi.spyOn(authority, 'loadLivePreparationAuthority').mockImplementationOnce(async (session, scopedDb, binding, clock) => {
      await db.update(schema.users).set({ disabledAt: new Date(now) }).where(eq(schema.users.id, 1));
      return original(session, scopedDb, binding, clock);
    });
    await expect(runtime().execute(request())).rejects.toThrow('live_risk_identity');
    expect(raw).not.toHaveBeenCalled();
  });
  it('uses one original connection and private provider epoch from prepare through hold and SDK/POST boundaries', async () => {
    await actualClockFixture();
    const connect = vi.spyOn(pool, 'connect'), observe = vi.spyOn(HyperliquidLiveAccountObserver.prototype, 'observe'),
      collect = vi.spyOn(LiveProviderReadEpoch.prototype, 'collect'), hold = vi.spyOn(PostgresLiveReservations.prototype, 'hold');
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(result).toMatchObject({ state: 'filled', nonce: clock, outcome: { exchangeOrderId: '77', filledSize: '0.1' } });
    expect(connect).toHaveBeenCalledTimes(2); expect(observe).toHaveBeenCalledOnce(); expect(hold).toHaveBeenCalledOnce();
    expect(new Set(collect.mock.contexts).size).toBe(1); expect(new Set(collect.mock.calls.map(([session]) => session)).size).toBe(1);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/exchange'))).toHaveLength(1);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/rpc'))).toHaveLength(1);
    const [lease] = await db.select().from(schema.hyperliquidWsLeases); expect(lease?.state).toBe('closed');
    const [quota] = await db.select().from(schema.hyperliquidEgressQuota); expect(quota!.egressKey).toBe(config.value.hyperliquid.egressKey);
    // The exchange's own IOC answer is kept as settlement evidence at once and
    // marks the liability attempted; it alone grants no settlement release.
    const [reservation] = await db.select().from(schema.copyLiveRiskReservations); expect(reservation?.state).toBe('unknown');
    expect(reservation?.releaseEvidenceDigest).toBeNull();
    const [evidence] = await db.select().from(schema.copyLiveExecutionEvidence);
    expect(evidence).toMatchObject({ exchangeOrderId: '77', statusObservation: null, settlementCertificate: null });
    expect(evidence!.acknowledgement).toMatchObject({ oid: '77', totalSz: '0.1' });
  });
  it('records the real sign/submit phases but emits timing only after the financial boundary closes', async () => {
    await actualClockFixture();
    // This test advances the execution clock at the RPC boundary. Quota
    // admission and dispatch must share it, so a fast machine cannot mistake
    // the subsequent 5 s deadline for one more than 5 s in its own future.
    global = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema })), () => clock),
      { egressKey: config.value.hyperliquid.egressKey, ownerId: 'runtime-test' }, raw, () => clock);
    const original = raw.getMockImplementation()!;
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const originalCollect = LiveProviderReadEpoch.prototype.collect;
    vi.spyOn(LiveProviderReadEpoch.prototype, 'collect').mockImplementation(async function (this: LiveProviderReadEpoch, ...args) {
      const firstCollection = !this.hasCompleted(args[0]);
      const result = await originalCollect.apply(this, args);
      // Retain the original provider timestamps. The collection's real wait
      // consumes freshness; diagnostics must measure it without retiming it.
      if (firstCollection) clock += 125;
      return result;
    });
    raw.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/exchange'))
        expect(log.mock.calls.some(([event]) => typeof event === 'object' && event?.event === 'live_execution_timing')).toBe(false);
      const response = await original(url, init);
      if (String(url).endsWith('/rpc')) clock += 650;
      return response;
    });
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(result.state, JSON.stringify({ state: result.state, errorCode: result.errorCode, outcome: result.outcome })).toBe('filled');
    const events = log.mock.calls.map(([event]) => event).filter(event => typeof event === 'object' && event?.event === 'live_execution_timing');
    expect(events).toHaveLength(1);
    const timings = events[0].timings;
    expect(timings).toContainEqual(expect.objectContaining({ phase: 'prepare', stage: 'preparation_provider_collection', elapsedMs: 125, clockValid: true }));
    for (const stage of ['preparation_local_authority', 'preparation_existing_identity', 'preparation_canonical_source',
      'preparation_generation_manifest', 'preparation_sizing_plan', 'preparation_journal_transaction'])
      expect(timings).toContainEqual(expect.objectContaining({ phase: 'prepare', stage }));
    for (const stage of ['epoch_local_authority', 'epoch_budget', 'epoch_leverage_preview', 'epoch_first_wave',
      'epoch_account_snapshots', 'epoch_other_markets', 'epoch_final_modes', 'epoch_final_authority'])
      expect(timings).toContainEqual(expect.objectContaining({ phase: 'collect', stage }));
    expect(timings).toContainEqual(expect.objectContaining({ phase: 'execute', stage: 'executor_sign', elapsedMs: 650, clockValid: true }));
    expect(timings).toContainEqual(expect.objectContaining({ phase: 'sign', stage: 'signer_rpc', elapsedMs: 650, clockValid: true }));
    for (const phase of ['hold', 'sign', 'submit'])
      expect(timings).toContainEqual(expect.objectContaining({ phase, stage: 'risk_final_local_read' }));
    expect(timings).toContainEqual(expect.objectContaining({ stage: 'executor_submit' }));
    expect(timings.length).toBeLessThanOrEqual(128);
    const text = JSON.stringify(events);
    for (const timing of timings)
      expect(Object.keys(timing)).toEqual(['network', 'phase', 'stage', 'elapsedMs', 'totalMs', 'clockValid']);
    expect(text).not.toContain('"signature":');
    expect(text).not.toContain('"authorization":');
    expect(text).not.toContain(authorizationKey);
    expect(text).not.toContain(agent.address);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/exchange'))).toHaveLength(1);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/rpc'))).toHaveLength(1);
  });
  it('keeps the actual filled journal when timing log output throws after execution', async () => {
    await actualClockFixture();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => { throw Error('log output unavailable'); });
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(result.state).toBe('filled');
    const [journal] = await db.select().from(schema.copyLiveExecutions);
    expect(journal?.state).toBe('filled');
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/exchange'))).toHaveLength(1);
  });
  it('measures a slow signing response while still refusing expired evidence before exchange POST', async () => {
    await actualClockFixture();
    const original = raw.getMockImplementation()!;
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    raw.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).endsWith('/rpc')) clock += 5001;
      return response;
    });
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow(/live_risk_(serialization_)?stale/);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/exchange'))).toHaveLength(0);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/rpc'))).toHaveLength(1);
    const event = log.mock.calls.map(([value]) => value).find(value => typeof value === 'object' && value?.event === 'live_execution_timing');
    expect(event.timings).toContainEqual(expect.objectContaining({ phase: 'sign', stage: 'signer_rpc', elapsedMs: 5001 }));
    const [journal] = await db.select().from(schema.copyLiveExecutions);
    expect(journal?.state).not.toBe('filled');
  });
  it.each([false, true])('preserves a committed fill after slow ACK, with completion logging failure=%s', async loggingFails => {
    await actualClockFixture();
    const originalClock = clock;
    global = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema })), () => clock),
      { egressKey: config.value.hyperliquid.egressKey, ownerId: 'runtime-test' }, raw, () => clock);
    const original = raw.getMockImplementation()!;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      if (loggingFails) throw Error('completion logging unavailable');
    });
    raw.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).endsWith('/rpc')) clock += 650;
      // The last pre-POST scope proof is still within 5 s. The oldest
      // preparation proof exceeds 5 s only after the genuine POST response.
      if (String(url).endsWith('/exchange')) clock += 4500;
      return response;
    });
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(result.state).toBe('filled');
    const [journal] = await db.select().from(schema.copyLiveExecutions);
    expect(journal?.state).toBe('filled');
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/exchange'))).toHaveLength(1);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/rpc'))).toHaveLength(1);
    const diagnostics = warn.mock.calls.map(([event]) => event).filter(event =>
      typeof event === 'object' && event?.event === 'live_execution_completion_stale');
    expect(diagnostics).toEqual([expect.objectContaining({ oldestCheckedAt: originalClock,
      completedAt: originalClock + 5150, evidenceAgeMs: 5150, freshnessLimitMs: 5000 })]);
    const locks = await db.execute(sql`select count(*)::int as n from pg_locks where locktype='advisory' and classid=7404 and objid=1
      and pid in (select pid from pg_stat_activity where datname=current_database())`);
    expect(Number(locks.rows[0]?.n)).toBe(0);
  });
  it('preserves an unknown slow exchange acknowledgement without inventing a fill or resending', async () => {
    await actualClockFixture();
    global = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema })), () => clock),
      { egressKey: config.value.hyperliquid.egressKey, ownerId: 'runtime-test' }, raw, () => clock);
    const previous = raw.getMockImplementation()!;
    raw.mockImplementation(async (url, init) => {
      const response = String(url).endsWith('/exchange') ? Response.json({ status: 'err', response: 'Nonce already used' }) : await previous(url, init);
      if (String(url).endsWith('/rpc')) clock += 650;
      if (String(url).endsWith('/exchange')) clock += 4500;
      return response;
    });
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(result.state).toBe('unknown');
    expect((await db.select().from(schema.copyLiveExecutions))[0]?.state).toBe('unknown');
    expect(await db.select().from(schema.copyLiveExecutionEvidence)).toHaveLength(0);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/exchange'))).toHaveLength(1);
    expect(raw.mock.calls.filter(([url]) => String(url).endsWith('/rpc'))).toHaveLength(1);
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]?.state).not.toBe('released');
  });
  it('waits for original never-placed expiry plus grace without provider quota or journal mutation', async () => {
    await actualClockFixture();
    const previous = raw.getMockImplementation()!;
    raw.mockImplementation(async (url, init) => {
      const response = await previous(url, init);
      if (String(url).endsWith('/rpc')) clock += 5001;
      return response;
    });
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow(/live_risk_(serialization_)?stale/);
    // Seed the terminal routing state from the real prepared journal in this
    // isolated database; a signing refusal itself correctly leaves prepared.
    const [prepared] = await db.select().from(schema.copyLiveExecutions);
    const terminal = { ...prepared!.record, state: 'rejected' as const, errorCode: 'exchange_order_never_placed',
      outcome: { state: 'rejected' as const, reason: 'final_execution_check_failed' }, updatedAt: clock };
    await db.update(schema.copyLiveExecutions).set({ state: 'rejected', record: terminal, updatedAt: new Date(clock) });
    const before = await db.select().from(schema.copyLiveExecutions);
    expect(before[0]?.record).toMatchObject({ state: 'rejected', errorCode: 'exchange_order_never_placed' });
    const acquire = vi.spyOn(budget, 'acquire'), scan = vi.fn(async () => {});
    raw.mockClear(); acquire.mockClear();
    const settler = new CopyLiveSettler('testnet', pool, global, budget, { runFor: scan }, () => clock);
    const record = before[0]!.record as unknown as import('../src/copy/live/live-execution.js').LiveExecutionRecord;
    const result = await settler.settle({ userId: 1, accountId: 'account', accountAddress: record.authorization.accountAddress,
      sourceNetwork: 'testnet', leaderAddress: seed.consent.leaderAddress, key: record.key });
    expect(result).toEqual({ kind: 'pending', reason: 'live_settlement_never_placed_grace' });
    expect(raw).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled();
    expect(await db.select().from(schema.copyLiveExecutions)).toEqual(before);
    expect(await db.select().from(schema.copyLiveExecutionEvidence)).toHaveLength(0);
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]?.state).not.toBe('released');
  });
  it.each(['expired grace', 'evidence oid', 'reservation oid'] as const)('retains full settlement path for %s', async boundary => {
    await actualClockFixture();
    const completed = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    const terminal = { ...completed, state: 'rejected' as const, errorCode: 'exchange_order_never_placed',
      outcome: { state: 'rejected' as const, reason: 'final_execution_check_failed' }, updatedAt: clock };
    await db.update(schema.copyLiveExecutions).set({ state: 'rejected', record: terminal, updatedAt: new Date(clock) });
    if (boundary !== 'evidence oid') await db.delete(schema.copyLiveExecutionEvidence);
    if (boundary === 'reservation oid') await db.update(schema.copyLiveRiskReservations).set({ exchangeOrderId: '77' });
    if (boundary === 'expired grace') clock = completed.expiresAfter + 80_001;
    const refill = vi.spyOn(budget, 'refillMs').mockImplementation(() => { throw Error('original settlement path'); });
    raw.mockClear();
    const settler = new CopyLiveSettler('testnet', pool, global, budget, { runFor: async () => {} }, () => clock);
    await expect(settler.settle({ userId: 1, accountId: 'account', accountAddress: completed.authorization.accountAddress,
      sourceNetwork: 'testnet', leaderAddress: seed.consent.leaderAddress, key: completed.key })).rejects.toThrow('original settlement path');
    expect(refill).toHaveBeenCalledOnce(); expect(raw).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]?.state).not.toBe('released');
  });
  it('waits for initial evidence weight before acquiring the original SQL lock session', async () => {
    await actualClockFixture();
    const connect = vi.spyOn(pool, 'connect'), original = budget.acquire.bind(budget);
    let connectionsWhenWaiting = 0;
    vi.spyOn(budget, 'acquire').mockImplementationOnce(async (...args) => {
      connectionsWhenWaiting = connect.mock.calls.length;
      await original(...args);
      await new Promise(resolve => setTimeout(resolve, 6000)); clock = Date.now();
    });
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(result.state).toBe('filled');
    expect(connectionsWhenWaiting).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
  }, 15_000);
  it('takes exactly the REST weight its reads send, at most 450 for an order', async () => {
    await actualClockFixture();
    const acquire = vi.spyOn(budget, 'acquire');
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(result.state).toBe('filled');
    const info = raw.mock.calls.filter(([url]) => String(url).endsWith('/info')).map(([, init]) => JSON.parse(String(init?.body)) as { type: string });
    // Info reads by Hyperliquid's weights, and 1 per exchange action.
    const sent = info.reduce((sum, body) => sum + (body.type === 'userRole' ? 60 : ['spotClearinghouseState', 'orderStatus'].includes(body.type) ? 2 : 20), 0)
      + raw.mock.calls.filter(([url]) => String(url).endsWith('/exchange')).length;
    const acquired = acquire.mock.calls.reduce((sum, [weight]) => sum + weight, 0);
    expect(acquired).toBe(sent); expect(acquired).toBeLessThanOrEqual(450);
    // The account modes once in the first wave and once in the final check;
    // every other shared read once.
    expect(info.filter(b => b.type === 'userRole')).toHaveLength(2);
    for (const type of ['userFees', 'metaAndAssetCtxs', 'spotMeta', 'allPerpMetas', 'activeAssetData', 'meta', 'extraAgents']) expect(info.filter(b => b.type === type)).toHaveLength(1);
    expect(acquired).toBe(385);
  });
  it('prepays agent approval before the SQL clock instead of waiting during signing', async () => {
    await actualClockFixture();
    const original = budget.acquire.bind(budget);
    vi.spyOn(budget, 'acquire').mockImplementation(async (...args) => {
      await original(...args);
      if (args[0] === 20) { await new Promise(resolve => setTimeout(resolve, 6000)); clock = Date.now(); }
    });
    expect((await runtime(config, { ...options, slippageBps: '0' }).execute(request())).state).toBe('filled');
  }, 15_000);
  it('waits for settlement account evidence before taking the original SQL locks, without releasing unproven liabilities', async () => {
    await actualClockFixture();const record=await runtime(config,{...options,slippageBps:'0'}).execute(request());
    const previous=raw.getMockImplementation()!;
    raw.mockImplementation(async(url,init)=>{
      const body=init?.body?JSON.parse(String(init.body)):undefined;
      if(String(url).endsWith('/info')&&body?.type==='orderStatus')return Response.json({status:'order',order:{status:'filled',statusTimestamp:record.nonce,
        order:{coin:'BTC',oid:77,cloid:record.action.orders[0].c,side:'B',reduceOnly:false,tif:'Ioc',origSz:record.action.orders[0].s,sz:'0',limitPx:record.action.orders[0].p,timestamp:record.nonce,isTrigger:false,isPositionTpsl:false,children:[]}}});
      return previous(url,init);
    });
    // Status recording is independently covered by the settlement DAL suite.
    // Leave receipts absent: this timing test must NEVER release the hold.
    vi.spyOn(PostgresLiveSettlement.prototype,'observe').mockResolvedValue({kind:'recorded',oid:'77',revision:1});
    const acquire=budget.acquire.bind(budget),locks:number[]=[];
    vi.spyOn(budget,'acquire').mockImplementation(async(...args)=>{
      await acquire(...args);
      if(args[0]>=OBSERVER_REST_WEIGHT){
        const rows=await db.execute(sql`select count(*)::int as n from pg_locks where locktype='advisory' and classid=7404 and objid=1 and pid in (select pid from pg_stat_activity where datname=current_database())`);
        locks.push(Number(rows.rows[0]?.n));await new Promise(resolve=>setTimeout(resolve,6000));clock=Date.now();
      }
    });
    const settler=new CopyLiveSettler('testnet',pool,global,budget,{runFor:async()=>{}},()=>clock);
    const outcome=await settler.settle({userId:1,accountId:'account',accountAddress:record.authorization.accountAddress,sourceNetwork:'testnet',leaderAddress:seed.consent.leaderAddress,key:record.key});
    expect(locks).toEqual([0]);expect(outcome.kind).toBe('pending');
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.state).toBe('unknown');
  },20_000);
  it('reconciles an unknown original key after revocation and strategy stop without another signature or nonce', async () => {
    await actualClockFixture();
    const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url).endsWith('/exchange') ? Promise.resolve(Response.json({ status: 'err', response: 'Nonce already used' })) : previous(url, init));
    const original = await runtime(config, { ...options, slippageBps: '0' }).execute(request()); expect(original.state).toBe('unknown');
    const revoked = await revokeHistoricalGrant(); expect(revoked.version).toBe(original.authorization.version + 1);
    await db.update(schema.copyStrategies).set({ status: 'stopped', stoppedAt: new Date(clock + 1) });
    await db.update(schema.copyLiveMandates).set({ state: 'paused', revision: 3 });
    raw.mockClear(); const sign = vi.spyOn(BoundaryPrivyOrderSigningClient.prototype, 'signTypedData');
    const recovered = await runtime().execute(request());
    expect(recovered).toMatchObject({ key: original.key, nonce: original.nonce, state: 'unknown' }); expect(sign).not.toHaveBeenCalled();
    expect(raw.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).type)).toEqual(['meta', 'orderStatus']);
    expect(await db.select().from(schema.copySignerNonces)).toHaveLength(1);
  });
  it('returns a terminal original key without querying or signing even after local consent expires', async () => {
    await actualClockFixture(); const original = await runtime(config, { ...options, slippageBps: '0' }).execute(request()); raw.mockClear(); clock += 60001;
    const result = await runtime().execute(request()); expect(result).toEqual(original); expect(raw).not.toHaveBeenCalled();
  });
  it('retains historical identity after the real agent expiry writer revokes the grant with transaction-start event time', async () => {
    await actualClockFixture(); const original = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    clock += 60001; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let transactionStartedAt: Date | undefined;
    await db.transaction(async tx => {
      const result = await tx.execute(sql`select now() as started_at`);
      const start = result.rows[0]!.started_at;
      transactionStartedAt = start instanceof Date ? start : new Date(String(start));
      await new CopyAgentRepository(db).ensure(tx, 1, 'account', { idempotencyKey: 'runtime-replacement-agent', validForDays: 1 }, 'worker');
    });
    const [grant] = await db.select().from(schema.copyWalletAuthorizations), [event] = await db.select().from(schema.copyWalletAuthorizationEvents);
    expect(grant!.version).toBe(original.authorization.version + 1); expect(event!.version).toBe(grant!.version);
    // The database and application clocks need not order each other. Prove
    // the event uses the transaction's actual clock, rather than a JS guess.
    expect(event!.createdAt.getTime()).toBe(transactionStartedAt!.getTime());
    raw.mockClear(); expect(await runtime().execute(request())).toEqual(original); expect(raw).not.toHaveBeenCalled();
  });
  it.each(['missing event', 'wrong owner', 'version gap', 'changed scopes', 'changed validity', 'future event', 'future revocation',
    'revocation before admission'] as const)(
    'refuses a historical revoked grant with %s before any provider call', async corruption => {
      await actualClockFixture(); const original = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
      await revokeHistoricalGrant();
      if (corruption === 'missing event') await db.delete(schema.copyWalletAuthorizationEvents);
      if (corruption === 'wrong owner') {
        const [foreign] = await db.insert(schema.users).values({ privyUserId: 'did:privy:runtime-event-foreign' }).returning();
        await db.update(schema.copyWalletAuthorizationEvents).set({ userId: foreign!.id });
      }
      if (corruption === 'version gap') await db.update(schema.copyWalletAuthorizations).set({ version: original.authorization.version + 2 });
      if (corruption === 'changed scopes') await db.update(schema.copyWalletAuthorizations).set({ scopes: ['copy:reduce'] });
      if (corruption === 'changed validity') await db.update(schema.copyWalletAuthorizations).set({ expiresAt: new Date(original.authorization.expiresAt + 1) });
      if (corruption === 'future event') await db.update(schema.copyWalletAuthorizationEvents).set({ createdAt: new Date(clock + 1) });
      if (corruption === 'future revocation') await db.update(schema.copyWalletAuthorizations).set({ revokedAt: new Date(clock + 1) });
      if (corruption === 'revocation before admission') await db.update(schema.copyWalletAuthorizations).set({ revokedAt: new Date(original.createdAt - 1) });
      raw.mockClear(); await expect(runtime().execute(request())).rejects.toThrow('live_runtime_historical_identity'); expect(raw).not.toHaveBeenCalled();
    });
  it('waits for a real revoked grant event ahead of the app clock and accepts it only after the read clock catches up', async () => {
    await actualClockFixture(); const original = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    await revokeHistoricalGrant();
    // Model SQL ahead of app time without restamping the grant or saved order.
    await db.update(schema.copyWalletAuthorizationEvents).set({ createdAt: new Date(clock + 1) });
    raw.mockClear(); await expect(runtime().execute(request())).rejects.toThrow('live_runtime_historical_identity');
    expect(raw).not.toHaveBeenCalled(); clock += 2;
    expect(await runtime().execute(request())).toEqual(original); expect(raw).not.toHaveBeenCalled();
  });
  it('does not use a historical revoke event for new financial admission', async () => {
    await actualClockFixture(); await revokeHistoricalGrant(); raw.mockClear();
    await expect(runtime().execute(request())).rejects.toThrow(); expect(raw).not.toHaveBeenCalled();
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
  });
  it('keeps a pre-sign held preparation durable and refuses adopting its reservation in a successor invocation', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url) === 'https://api.privy.io/v1/wallets/agent'
      ? Promise.reject(Error('Offline wallet failure')) : previous(url, init));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow();
    const [prepared] = await db.select().from(schema.copyLiveExecutions); expect(prepared!.state).toBe('prepared');
    expect(await db.select().from(schema.copyLiveRiskReservations)).toHaveLength(1);
    raw.mockClear();
    await expect(runtime().execute(request())).rejects.toThrow('live_runtime_reservation_recovery_required');
    expect(raw).not.toHaveBeenCalled(); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(1);
  });
  it('returns the terminal journal after a slow completed response and keeps subsequent recovery read-only', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation(async (url, init) => { const response = await previous(url, init); if (String(url).endsWith('/exchange')) clock += 5001; return response; });
    expect((await runtime(config, { ...options, slippageBps: '0' }).execute(request())).state).toBe('filled');
    const [journal] = await db.select().from(schema.copyLiveExecutions); expect(journal?.state).toBe('filled');
    raw.mockClear(); const recovered = await runtime().execute(request()); expect(recovered.state).toBe('filled'); expect(raw).not.toHaveBeenCalled();
  });
  it('does not accept a caller-supplied gate or proof array on an otherwise valid routing request', async () => {
    await expect(runtime().execute({ ...request(), proof: seed.f } as LiveExecutionRequest)).rejects.toThrow('live_runtime_request');
    expect(raw).not.toHaveBeenCalled();
  });
  it('binds the configured worker quorum to the current owner consent before collecting any provider proof', async () => {
    await expect(runtime(configuration({ PRIVY_AGENT_WORKER_QUORUM_ID: 'foreign-worker' })).execute(request())).rejects.toThrow('live_runtime_signing_configuration');
    expect(raw).not.toHaveBeenCalled(); expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
  it('captures deployment settings and routing IDs before asynchronous SQL starts', async () => {
    await actualClockFixture(); const deployment = { ...options, slippageBps: '0' }, originalRequest = request();
    const execution = runtime(config, deployment); deployment.slippageBps = '500';
    const pending = execution.execute(originalRequest); Object.assign(originalRequest, { accountId: 'foreign', userId: 2, sourceFillId: 'foreign' });
    const result = await pending; expect(result.action.orders[0]!.p).toBe('100'); expect(result.authorization.userId).toBe(1);
  });
  it('never queries a corrupted historical journal bound to a different owner', async () => {
    await actualClockFixture(); const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    const secondOwner = await db.insert(schema.users).values({ privyUserId: 'did:privy:foreign-runtime' }).returning();
    const [journal] = await db.select().from(schema.copyLiveExecutions);
    await db.update(schema.copyLiveExecutions).set({ userId: secondOwner[0]!.id,
      record: { ...journal!.record, authorization: { ...result.authorization, userId: secondOwner[0]!.id } } });
    raw.mockClear(); await expect(runtime().execute(request())).rejects.toThrow(); expect(raw).not.toHaveBeenCalled();
  });
  it('certifies an expired never-submitted hold after revocation and stop on the original session without provider or signing work', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url) === 'https://api.privy.io/v1/wallets/agent' ? Promise.reject(Error('Pre-sign fault')) : previous(url, init));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow();
    const [prepared] = await db.select().from(schema.copyLiveExecutions), [held] = await db.select().from(schema.copyLiveRiskReservations);
    const [originalCarry] = await db.select().from(schema.copyLiveReductionCarry);
    clock += 60001;
    const revoked = await revokeHistoricalGrant(); expect(revoked.version).toBe((prepared!.record as unknown as { authorization: { version: number } }).authorization.version + 1);
    await db.update(schema.copyStrategies).set({ status: 'stopped', stoppedAt: new Date(clock) });
    await db.update(schema.copyLiveMandates).set({ state: 'paused', revision: 3 });
    raw.mockClear();
    const recovery = vi.spyOn(PostgresLiveUnattemptedRecovery.prototype, 'releaseExpired'), sign = vi.spyOn(BoundaryPrivyOrderSigningClient.prototype, 'signTypedData');
    const originalContext = global.runOriginal.bind(global), originalSessions: object[] = [];
    vi.spyOn(global, 'runOriginal').mockImplementation((session, work) => { originalSessions.push(session); return originalContext(session, work); });
    const result = await runtime().execute(request());
    expect(result).toMatchObject({ key: prepared!.key, nonce: prepared!.nonce, state: 'rejected', errorCode: 'unattempted_expired', unattemptedRelease: { kind: 'unattempted_expired' } });
    expect(raw).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled(); expect(recovery).toHaveBeenCalledOnce();
    expect(recovery.mock.calls[0]![0]).toBe(originalSessions[0]); expect(recovery.mock.calls[0]![1].expectedReservationRevision).toBe(held!.revision);
    const [released] = await db.select().from(schema.copyLiveRiskReservations), [leg] = await db.select().from(schema.copyLiveSignalLegs);
    expect(released).toMatchObject({ state: 'released', releaseReason: 'unattempted_expired', attemptedAt: null, exchangeOrderId: null });
    expect(leg!.state).toBe('skipped'); expect(await db.select().from(schema.copyLiveReductionCarry)).toEqual([originalCarry]);
    expect(await db.select().from(schema.copySignerNonces)).toHaveLength(1);
    const replay = await runtime().execute(request()); expect(replay).toEqual(result); expect(raw).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.revision).toBe(released!.revision);
  });
  it('retains unknown attempted liability after expiry and never calls never-submitted recovery', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url).endsWith('/exchange') ? Promise.resolve(Response.json({ status: 'err', response: 'Nonce already used' })) : previous(url, init));
    const original = await runtime(config, { ...options, slippageBps: '0' }).execute(request()); expect(original.state).toBe('unknown');
    clock += 60001; raw.mockClear(); const recovery = vi.spyOn(PostgresLiveUnattemptedRecovery.prototype, 'releaseExpired');
    const result = await runtime().execute(request()); expect(result).toMatchObject({ key: original.key, nonce: original.nonce, state: 'unknown' });
    expect(recovery).not.toHaveBeenCalled();
    const [held] = await db.select().from(schema.copyLiveRiskReservations); expect(held!.state).toBe('held'); expect(held!.releaseEvidenceDigest).toBeNull();
    expect(raw.mock.calls.every(([url]) => String(url) === 'https://api.hyperliquid-testnet.xyz/info')).toBe(true);
    expect(await db.select().from(schema.copySignerNonces)).toHaveLength(1);
  });
  it('denies a signed fixed10 budget at nonzero slippage before any journal, signing RPC or financial POST', async () => {
    // 10 USD at a 100.3 buy limit floors to 0.09 (9.03 USD); rounding up to 0.1
    // (10.03 USD) would pass the copy's own 10 USD with no deployment maximum.
    await actualClockFixture();
    const sign = vi.spyOn(BoundaryPrivyOrderSigningClient.prototype, 'signTypedData');
    await expect(runtime().execute(request())).rejects.toThrow('below_min_notional');
    expect(sign).not.toHaveBeenCalled(); expect(raw.mock.calls.some(([url]) => String(url).endsWith('/exchange') || String(url).endsWith('/rpc'))).toBe(false);
    expect(raw.mock.calls.filter(([url]) => String(url) === 'https://api.privy.io/v1/wallets/agent')).toHaveLength(1);
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
  });
  it('holds an order on a deployment whose caps tighten the risk policy (every live one)', async () => {
    await actualClockFixture(20);
    // The fixture policy allows more copies and leverage than these caps.
    registerLiveDeployment({ network: 'testnet', caps: { maxStrategiesPerUser: 2, maxLeverage: 10, fixedPerTradeUsd: { min: 10, max: 25 } }, builderFee: true, testnetSourceIntervalMs: 60_000,
      maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300 });
    try { expect(await runtime().execute(request())).toMatchObject({ state: 'filled' }); }
    finally { registerLiveDeployment(undefined); }
  });
  it('rounds a fixed10 budget up to the exchange minimum within the deployment\'s per-trade maximum and sends it', async () => {
    await actualClockFixture();
    registerLiveDeployment({ network: 'testnet', caps: { maxStrategiesPerUser: 2, fixedPerTradeUsd: { min: 10, max: 15 } }, builderFee: true, testnetSourceIntervalMs: 60_000,
      maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300 });
    try {
      // 0.09 (9.03 USD at the 100.3 limit) is under the minimum; 0.1 (10.03 USD) is within 15.
      const result = await runtime().execute(request());
      expect(result).toMatchObject({ state: 'filled', action: { orders: [{ p: '100.3', s: '0.1' }] }, outcome: { filledSize: '0.1' } });
    } finally { registerLiveDeployment(undefined); }
  });
  it('executes a properly signed fixed20 budget at nonzero slippage with an acknowledgement matching the prepared quantity', async () => {
    await actualClockFixture(20); const result = await runtime().execute(request());
    expect(result).toMatchObject({ state: 'filled', action: { orders: [{ p: '100.3', s: '0.19' }] }, outcome: { filledSize: '0.19' } });
    const [mandate] = await db.select().from(schema.copyLiveMandates); expect(mandate!.settingsDigest).toBe(seed.consent.settingsDigest);
    const [record] = await db.select().from(schema.copyLiveExecutions); expect(record!.nonce).toBe(result.nonce);
  });
  it('allows only zero-effect expired cleanup after legitimate account verification advances its revision with stable identity', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url) === 'https://api.privy.io/v1/wallets/agent' ? Promise.reject(Error('Pre-sign fault')) : previous(url, init));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow();
    await db.update(schema.copyExecutionAccounts).set({ revision: 2, state: 'unknown' });
    clock += 60001; raw.mockClear(); const sign = vi.spyOn(BoundaryPrivyOrderSigningClient.prototype, 'signTypedData');
    const result = await runtime().execute(request()); expect(result).toMatchObject({ state: 'rejected', errorCode: 'unattempted_expired' });
    expect(raw).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.state).toBe('released');
    const replay = await runtime().execute(request()); expect(replay).toEqual(result); expect(raw).not.toHaveBeenCalled();
  });
  it('refuses expiry cleanup if an advanced account revision changed the immutable master wallet', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url) === 'https://api.privy.io/v1/wallets/agent' ? Promise.reject(Error('Pre-sign fault')) : previous(url, init));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow();
    await db.update(schema.copyExecutionAccounts).set({ revision: 2, privyWalletId: 'foreign-master' });
    clock += 60001; raw.mockClear();
    await expect(runtime().execute(request())).rejects.toThrow('live_runtime_historical_identity'); expect(raw).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.state).toBe('held');
  });
  it('does not apply a historical revision exception to unexpired held financial admission', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url) === 'https://api.privy.io/v1/wallets/agent' ? Promise.reject(Error('Pre-sign fault')) : previous(url, init));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow();
    await db.update(schema.copyExecutionAccounts).set({ revision: 2 }); raw.mockClear();
    await expect(runtime().execute(request())).rejects.toThrow('live_runtime_historical_identity'); expect(raw).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.state).toBe('held');
  });
  it('rejects a regressed account revision during zero-effect expiry cleanup', async () => {
    await actualClockFixture(10, 2); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url) === 'https://api.privy.io/v1/wallets/agent' ? Promise.reject(Error('Pre-sign fault')) : previous(url, init));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow();
    const [held] = await db.select().from(schema.copyLiveRiskReservations); expect(held!.state).toBe('held');
    await db.update(schema.copyExecutionAccounts).set({ revision: 1 }); clock += 60001; raw.mockClear();
    await expect(runtime().execute(request())).rejects.toThrow('live_runtime_historical_identity'); expect(raw).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.state).toBe('held');
  });
  it('keeps new financial preparation bound to the exact signed account revision', async () => {
    await db.update(schema.copyExecutionAccounts).set({ revision: 2 });
    await expect(runtime().execute(request())).rejects.toThrow('live_risk_mandate_changed');
    expect(raw).not.toHaveBeenCalled(); expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
    expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
  });
});

describe('a testnet copy of a MAINNET leader', () => {
  const mainnetOptions = { ...options, maxSourceDeviationBps: '500' };
  /** The actual-clock fixture, re-pointed at a mainnet leader: the consent,
   * config, stream and fill say `mainnet`; execution stays on testnet. */
  async function mainnetFixture(perTradeUsd: number | null = 20, sizingMode?: 'ratio') {
    await actualClockFixture(perTradeUsd, 1, sizingMode);
    const consent = { ...seed.consent, sourceNetwork: 'mainnet' as const };
    await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'mainnet' });
    await db.update(schema.copyLiveMandates).set({ sourceNetwork: 'mainnet', intent: consent, intentDigest: mandateDigest(consent) });
    await db.delete(schema.copyLiveSourceFills); await db.delete(schema.copyLiveSourceStreams);
    const fill = parseLiveSourceFill({ ...seed.fill.raw, time: clock - 1000 }, { network: 'mainnet', leaderAddress: consent.leaderAddress,
      from: clock - 2000, to: clock, receivedAt: clock, kind: 'fills' });
    await db.insert(schema.copyLiveSourceStreams).values({ id: fill.streamId, network: 'mainnet', leaderAddress: fill.leaderAddress, state: 'ready',
      coverageFrom: new Date(clock - 3000), coverageThrough: new Date(clock), coverageDigest: 'c'.repeat(64) });
    await db.insert(schema.copyLiveSourceFills).values({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) });
    seed = { ...seed, consent, fill };
  }
  const reference = (midPrice: string) => ({ network: 'mainnet' as const, read: vi.fn(async () => ({ midPrice, midObservedAt: clock, leaderEquity: null, leaderEquityObservedAt: null })) });
  const mainnetRuntime = (hooks: ConstructorParameters<typeof LiveExecutionRuntime>[7]) =>
    new LiveExecutionRuntime('testnet', pool, config, global, budget, mainnetOptions, () => clock, hooks);
  it('prices the order on testnet, records the mainnet reference and reports exchange timing', async () => {
    await mainnetFixture(); const events: string[] = [], source = reference('101');
    const result = await mainnetRuntime({ reference: source, onExchange: event => events.push(event.phase) }).execute(request());
    expect(result).toMatchObject({ state: 'filled', action: { orders: [{ p: '100.3', s: '0.19' }] } });
    expect(source.read).toHaveBeenCalledWith(seed.consent.leaderAddress, 'BTC', false);
    expect(events).toEqual(['request', 'response']);
    const [provenance] = await db.select().from(schema.copyLiveIntentProvenance);
    expect((provenance!.sizingBasis as { basis: { sourceReference: unknown } }).basis.sourceReference).toEqual({ network: 'mainnet',
      leaderAddress: seed.consent.leaderAddress, leaderEquity: null, leaderEquityObservedAt: null, midPrice: '101', midObservedAt: clock, maxDeviationBps: '500' });
    // No mainnet endpoint is ever called by the execution path itself.
    expect(raw.mock.calls.some(([url]) => String(url).startsWith('https://api.hyperliquid.xyz'))).toBe(false);
  });
  it('refuses when the testnet mid sits beyond the deviation threshold, before any journal, nonce or signature', async () => {
    await mainnetFixture(); const sign = vi.spyOn(BoundaryPrivyOrderSigningClient.prototype, 'signTypedData');
    await expect(mainnetRuntime({ reference: reference('110') }).execute(request())).rejects.toThrow('live_source_price_deviation');
    expect(sign).not.toHaveBeenCalled(); expect(raw.mock.calls.some(([url]) => String(url).endsWith('/exchange'))).toBe(false);
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
  });
  it('refuses a mainnet source without a configured reference reader', async () => {
    await mainnetFixture();
    await expect(mainnetRuntime({}).execute(request())).rejects.toThrow('live_source_reference_unconfigured');
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
  describe('one merged adjustment (ratio sizing)', () => {
    /** Three more adds of the leader's BTC long after the seed fill (long 1 -> 4). */
    async function adds() {
      const ids: string[] = [];
      for (const [i, start] of ['1', '2', '3'].entries()) {
        const fill = parseLiveSourceFill({ ...seed.fill.raw, tid: 2 + i, oid: 3 + i, time: clock - 900 + i * 100, startPosition: start },
          { network: 'mainnet', leaderAddress: seed.consent.leaderAddress, from: clock - 2000, to: clock, receivedAt: clock, kind: 'fills' });
        await db.insert(schema.copyLiveSourceFills).values({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) });
        ids.push(fill.id);
      }
      return ids;
    }
    const equity = (leaderEquity: string) => ({ network: 'mainnet' as const, read: vi.fn(async () => ({ midPrice: '100', midObservedAt: clock, leaderEquity, leaderEquityObservedAt: clock })) });
    it('sends one order of the four legs\' summed size and claims the other three legs', async () => {
      await mainnetFixture(null, 'ratio'); const later = await adds(), lead = later[2]!, members = [seed.fill.id, later[0]!, later[1]!];
      // The newest add leads; it carries the three before it.
      const result = await mainnetRuntime({ reference: equity('1000') }).execute({ ...request(), sourceFillId: lead, members });
      // 4 x (1 @ 100) of a 1,000 account, at a 100 budget, at mid 100: 0.4 (one leg alone: 0.1).
      expect(result).toMatchObject({ state: 'filled', action: { orders: [{ s: '0.4' }] } });
      const [provenance] = await db.select().from(schema.copyLiveIntentProvenance);
      expect((provenance!.sizingBasis as { basis: { merged: { members: { sourceFillId: string }[] } } }).basis.merged.members.map(m => m.sourceFillId)).toEqual([...members, lead]);
      const legs = await db.select().from(schema.copyLiveSignalLegs);
      expect(legs.find(l => l.sourceFillId === lead)).toMatchObject({ state: 'prepared', executionKey: result.key });
      expect(legs.filter(l => members.includes(l.sourceFillId))).toEqual(members.map(() => expect.objectContaining({ state: 'skipped', executionKey: null })));
      // Settlement and recovery re-plan from the saved basis and the order's own fill alone: the same order.
      const [mandate] = await db.select().from(schema.copyLiveMandates), [version] = await db.select().from(schema.copyStrategyVersions), [policy] = await db.select().from(schema.copyRiskPolicies);
      const [own] = await db.select().from(schema.copyLiveSourceFills).where(eq(schema.copyLiveSourceFills.id, lead)), fill = decodeLiveSourceFill(own!);
      const replanned = planLiveSourceOrder({ mandate: { ...mandate!, state: 'active', revision: provenance!.mandateRevision }, settings: copyStrategySettingsSchema.strict().parse(version!.settings),
        fill, leg: canonicalLiveSourceLegs(fill)[0]!, sizingBasis: provenance!.sizingBasis, now: result.createdAt, limits: copyRiskLimitsSchema.parse(policy!.limits), currentExecutionKey: result.key,
        members: (await db.select().from(schema.copyLiveSourceFills).where(inArray(schema.copyLiveSourceFills.id, members))).map(decodeLiveSourceFill) });
      expect(replanned.order.size).toBe('0.4');
    });
    it('refuses a merge below the minimum before any journal or nonce claims it', async () => {
      await mainnetFixture(null, 'ratio'); const later = await adds();
      // A 10,000 account: 0.04 BTC at 100, 4 USDC.
      await expect(mainnetRuntime({ reference: equity('10000') }).execute({ ...request(), sourceFillId: later[2]!, members: [seed.fill.id, later[0]!, later[1]!] })).rejects.toThrow('below_min_notional');
      expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
      expect(await db.select().from(schema.copyLiveSignalLegs)).toHaveLength(0);
    });
    it('refuses a merge carrying a leg the worker holds as its own work row, or merged into another order', async () => {
      await mainnetFixture(null, 'ratio'); const later = await adds(), request_ = { ...request(), sourceFillId: later[2]!, members: [later[0]!, later[1]!] };
      const row = (fill: string, adjustmentId: string | null) => ({ id: `mandate|${fill}|open`, mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: fill,
        leg: 'open' as const, coin: 'BTC', leaderTime: new Date(clock - 900), receivedAt: new Date(clock - 800), adjustmentId });
      await db.insert(schema.copyLiveDispatches).values([row(later[2]!, null), row(later[0]!, null)]);
      await expect(mainnetRuntime({ reference: equity('1000') }).execute(request_)).rejects.toThrow('live_preparation_claim_conflict');
      // Merged into another order's adjustment (led by the seed fill's row).
      await db.insert(schema.copyLiveDispatches).values(row(seed.fill.id, null));
      await db.update(schema.copyLiveDispatches).set({ adjustmentId: `mandate|${seed.fill.id}|open` }).where(eq(schema.copyLiveDispatches.sourceFillId, seed.fill.id));
      await db.update(schema.copyLiveDispatches).set({ state: 'refused', reason: 'merged_into_adjustment', adjustmentId: `mandate|${seed.fill.id}|open` }).where(eq(schema.copyLiveDispatches.sourceFillId, later[0]!));
      await expect(mainnetRuntime({ reference: equity('1000') }).execute(request_)).rejects.toThrow('live_preparation_claim_conflict');
      expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
      // Merged into THIS order's lead: accepted.
      await db.update(schema.copyLiveDispatches).set({ adjustmentId: `mandate|${later[2]!}|open` }).where(eq(schema.copyLiveDispatches.sourceFillId, later[0]!));
      expect((await mainnetRuntime({ reference: equity('1000') }).execute(request_)).state).toBe('filled');
    });
    it('applies the per-order cap to the merged size: four legs each under it, together over it, are refused', async () => {
      await mainnetFixture(null, 'ratio'); const later = await adds();
      // At most 30 USDC an order: each leg alone is 0.1 BTC (~10 USDC), the four together 0.4 (~40).
      const [policy] = await db.select().from(schema.copyRiskPolicies);
      await db.update(schema.copyRiskPolicies).set({ limits: { ...policy!.limits as object, maxOrderNotionalUsd: 30 } });
      const sign = vi.spyOn(BoundaryPrivyOrderSigningClient.prototype, 'signTypedData');
      const merged = await mainnetRuntime({ reference: equity('1000') }).execute({ ...request(), sourceFillId: later[2]!, members: [seed.fill.id, later[0]!, later[1]!] })
        .catch((error: Error) => error);
      expect(merged instanceof Error ? merged.message : merged.state).not.toBe('filled');
      expect(sign).not.toHaveBeenCalled(); expect(raw.mock.calls.some(([url]) => String(url).endsWith('/exchange'))).toBe(false);
      expect(JSON.stringify(merged instanceof Error ? merged.message : merged)).toContain('max_order');
    });
    it('refuses a merge carrying a leg another order already claimed', async () => {
      await mainnetFixture(null, 'ratio'); const members = await adds();
      // Another adjustment already carries members[0].
      const [fill] = await db.select().from(schema.copyLiveSourceFills).where(eq(schema.copyLiveSourceFills.id, members[0]!));
      const leg = canonicalLiveSourceLegs(decodeLiveSourceFill(fill!))[0]!;
      await db.insert(schema.copyLiveSignalLegs).values({ id: liveSourceLegId('mandate', members[0]!, 'open'), mandateId: 'mandate', sourceFillId: members[0]!, ...leg,
        state: 'skipped', revision: 2, createdAt: new Date(clock - 10), updatedAt: new Date(clock - 10) });
      await expect(mainnetRuntime({ reference: equity('1000') }).execute({ ...request(), sourceFillId: members[2]!, members: [members[0]!, members[1]!] })).rejects.toThrow('live_preparation_claim_conflict');
      expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
    });
  });
  it('never takes a testnet fill as a mainnet leader signal', async () => {
    await mainnetFixture();
    await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'testnet' });
    await expect(mainnetRuntime({ reference: reference('100') }).execute(request())).rejects.toThrow();
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
});

describe('the account leverage an open needs (a fresh account sits at the exchange default 20x)', () => {
  let leverage = 20;
  /** A default 20x account: activeAssetData answers `leverage`, which an accepted updateLeverage sets when `apply`. */
  async function defaultLeverageFixture(answer: unknown, apply = true) {
    await actualClockFixture(); leverage = 20; const previous = raw.getMockImplementation()!;
    raw.mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (String(url).endsWith('/exchange') && body.action.type === 'updateLeverage') {
        if (apply && (answer as { status?: string }).status === 'ok') leverage = body.action.leverage;
        return Response.json(answer);
      }
      const response = await previous(url, init);
      if (String(url).endsWith('/info') && body?.type === 'activeAssetData') return Response.json({ ...await response.json(), leverage: { type: 'cross', value: leverage } });
      return response;
    });
  }
  const exchangeActions = () => raw.mock.calls.filter(([url]) => String(url).endsWith('/exchange')).map(([, init]) => JSON.parse(String(init!.body)));
  it('lowers fresh-account leverage before paying for the full order evidence', async () => {
    await defaultLeverageFixture({ status: 'ok', response: { type: 'default' } });
    expect((await runtime(config, { ...options, slippageBps: '0' }).execute(request())).state).toBe('filled');
    const sent = raw.mock.calls.filter(([url]) => String(url).endsWith('/info')).map(([, init]) => JSON.parse(String(init!.body)));
    expect(sent.filter(body => body.type === 'userRole')).toHaveLength(2);
  });
  it('reuses unused prepaid evidence after lowering leverage when a second full budget reservation is unavailable', async () => {
    await defaultLeverageFixture({ status: 'ok', response: { type: 'default' } });
    const original = budget.acquire.bind(budget), reservations: number[] = [];
    vi.spyOn(budget, 'acquire').mockImplementation(async (...args) => {
      reservations.push(args[0]);
      // The first preview sent 40 of its prepaid evidence and the approval
      // sent 20, followed by its 1-weight action. Only spent weight needs
      // refilling for the fresh epoch;
      // competing reporting work cannot supply another full 385 reservation.
      if (leverage === 10 && args[0] > 61) throw new Error('second full evidence budget unavailable');
      return original(...args);
    });
    expect((await runtime(config, { ...options, slippageBps: '0' }).execute(request())).state).toBe('filled');
    expect(exchangeActions().map(body => body.action.type)).toEqual(['updateLeverage', 'order']);
    expect(reservations.reduce((sum, weight) => sum + weight, 0)).toBe(446);
  });
  it('returns unused prepaid weight when the leverage update is rejected, counting the action actually sent', async () => {
    await defaultLeverageFixture({ status: 'err', response: 'Cannot switch leverage type with open position.' });
    const acquire = vi.spyOn(budget, 'acquire'), adjust = vi.spyOn(budget, 'adjust');
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow('live_leverage_update_rejected');
    const net = acquire.mock.calls.reduce((sum, [weight]) => sum + weight, 0) + adjust.mock.calls.reduce((sum, [delta]) => sum + delta, 0);
    // Preview meta + activeAssetData (40), approval (20), updateLeverage (1).
    expect(net).toBe(61);
    expect(exchangeActions().map(body => body.action.type)).toEqual(['updateLeverage']);
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
  it('returns retained weight when the retry cannot acquire its top-up', async () => {
    await defaultLeverageFixture({ status: 'ok', response: { type: 'default' } });
    const original = budget.acquire.bind(budget), acquired: number[] = [];
    vi.spyOn(budget, 'acquire').mockImplementation(async (...args) => {
      if (leverage === 10) throw new Error('retry budget unavailable');
      await original(...args); acquired.push(args[0]);
    });
    const adjust = vi.spyOn(budget, 'adjust');
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow('retry budget unavailable');
    expect(acquired.reduce((sum, weight) => sum + weight, 0) + adjust.mock.calls.reduce((sum, [delta]) => sum + delta, 0)).toBe(61);
    expect(exchangeActions().map(body => body.action.type)).toEqual(['updateLeverage']);
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
  it('returns retained and topped-up weight when the retry cannot enter its SQL scope', async () => {
    await defaultLeverageFixture({ status: 'ok', response: { type: 'default' } });
    const original = PostgresLiveRiskScope.prototype.run;
    vi.spyOn(PostgresLiveRiskScope.prototype, 'run').mockImplementation(function (this: PostgresLiveRiskScope, ...args) {
      if (leverage === 10) return Promise.reject(new Error('retry scope unavailable'));
      return original.apply(this, args);
    });
    const acquire = vi.spyOn(budget, 'acquire'), adjust = vi.spyOn(budget, 'adjust');
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow('retry scope unavailable');
    expect(acquire.mock.calls.reduce((sum, [weight]) => sum + weight, 0) + adjust.mock.calls.reduce((sum, [delta]) => sum + delta, 0)).toBe(61);
    expect(exchangeActions().map(body => body.action.type)).toEqual(['updateLeverage']);
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
  it('sets the cap (cross) with a journaled, agent-signed updateLeverage, then sends the order', async () => {
    await defaultLeverageFixture({ status: 'ok', response: { type: 'default' } });
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(result.state).toBe('filled');
    const [update, order] = exchangeActions();
    // The fixture copy's cap: its settings' maxLeverage 10 (policy and coin allow more).
    expect(update.action).toEqual({ type: 'updateLeverage', asset: 0, isCross: true, leverage: 10 });
    expect(order.action.type).toBe('order');
    // One nonce allocator for both: the update's nonce precedes the order's.
    expect(update.nonce).toBeLessThan(order.nonce);
    const [journal] = await db.select().from(schema.copyLiveLeverageUpdates);
    expect(journal).toMatchObject({ accountId: 'account', coin: 'BTC', asset: 0, fromLeverage: 20, leverage: 10, state: 'accepted', nonce: update.nonce, issue: null });
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(1);
  });
  it('signs the update when the signer\'s nonce allocator is already ahead of the clock (expiry from the request clock)', async () => {
    await defaultLeverageFixture({ status: 'ok', response: { type: 'default' } });
    await db.insert(schema.copySignerNonces).values({ network: 'testnet', signerAddress: agent.address.toLowerCase(), nonce: clock + 10 });
    expect((await runtime(config, { ...options, slippageBps: '0' }).execute(request())).state).toBe('filled');
    const [journal] = await db.select().from(schema.copyLiveLeverageUpdates);
    expect(journal).toMatchObject({ state: 'accepted', nonce: clock + 11, expiresAfter: clock + 60_000 });
  });
  it('refuses permanently when the exchange rejects the update, before any order journal', async () => {
    await defaultLeverageFixture({ status: 'err', response: 'Cannot switch leverage type with open position.' });
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow('live_leverage_update_rejected');
    expect(exchangeActions()).toHaveLength(1);
    const [journal] = await db.select().from(schema.copyLiveLeverageUpdates); expect(journal).toMatchObject({ state: 'rejected', issue: 'exchange_rejected_leverage' });
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
  it('never loops: still above the cap after an accepted update is live_risk_leverage, with one update only', async () => {
    await defaultLeverageFixture({ status: 'ok', response: { type: 'default' } }, false);
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow('live_risk_leverage');
    expect(exchangeActions().map(body => body.action.type)).toEqual(['updateLeverage']);
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
});
describe('a refusal after the journal commits (no orphan journal)', () => {
  /** A second leader open on the fixture's stream, 100 ms after the first. */
  async function secondFill() {
    const fill = parseLiveSourceFill({ ...seed.fill.raw, tid: 2, oid: 3, time: clock - 900 }, { network: 'testnet', leaderAddress: seed.consent.leaderAddress,
      from: clock - 2000, to: clock, receivedAt: clock, kind: 'fills' });
    await db.insert(schema.copyLiveSourceFills).values({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) });
    return fill.id;
  }
  it('rejects the journal it prepared (never sent) and skips its leg, so the owner\'s next order is not blocked', async () => {
    await actualClockFixture();
    vi.spyOn(PostgresLiveReservations.prototype, 'hold').mockRejectedValueOnce(new LiveBoundaryError('available_collateral'));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow('available_collateral');
    const [journal] = await db.select().from(schema.copyLiveExecutions);
    expect(journal).toMatchObject({ state: 'rejected', record: { state: 'rejected', errorCode: UNHELD_REJECTED, outcome: { state: 'rejected', reason: 'available_collateral' } } });
    expect(await db.select().from(schema.copyLiveRiskReservations)).toHaveLength(0);
    expect((await db.select().from(schema.copyLiveSignalLegs))[0]).toMatchObject({ state: 'skipped', executionKey: journal!.key });
    expect(raw.mock.calls.some(([url]) => String(url).endsWith('/exchange') || String(url).endsWith('/rpc'))).toBe(false);
    // The next leg of the same generation is neither an orphan nor an unproven generation.
    const next = await secondFill();
    const result = await runtime(config, { ...options, slippageBps: '0' }).execute({ ...request(), sourceFillId: next });
    expect(result.state).toBe('filled');
  });
  it('recovers a crash between the journal and hold commits: rejected, never signed, on the next invocation', async () => {
    await actualClockFixture();
    vi.spyOn(PostgresLiveReservations.prototype, 'hold').mockRejectedValueOnce(new LiveBoundaryError('live_risk_stale'));
    // The worker dies before it can record the refusal.
    vi.spyOn(LiveExecutionRuntime.prototype as unknown as { rejectUnheld: () => Promise<unknown> }, 'rejectUnheld').mockRejectedValueOnce(Error('worker died'));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow('live_risk_stale');
    expect((await db.select().from(schema.copyLiveExecutions))[0]!.state).toBe('prepared');
    raw.mockClear();
    const recovered = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    expect(recovered).toMatchObject({ state: 'rejected', errorCode: UNHELD_REJECTED, outcome: { reason: 'live_hold_missing' } });
    expect(raw.mock.calls.some(([url]) => String(url).endsWith('/exchange') || String(url).endsWith('/rpc'))).toBe(false);
    expect((await db.select().from(schema.copyLiveSignalLegs))[0]!.state).toBe('skipped');
    const next = await secondFill();
    expect((await runtime(config, { ...options, slippageBps: '0' }).execute({ ...request(), sourceFillId: next })).state).toBe('filled');
  });
});
