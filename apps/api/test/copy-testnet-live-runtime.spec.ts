import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { TestnetLiveExecutionRuntime, type TestnetLiveExecutionRequest } from '../src/copy/live/testnet-live-execution-runtime.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { getTestDb, closeTestDb, type TestDb } from './db-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import * as authority from '../src/copy/live/postgres-live-risk-authority.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { TypedDataDefinition } from 'viem';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { parseLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { LiveProviderReadEpoch } from '../src/copy/live/live-provider-read-epoch.js';
import { PostgresLiveReservations } from '../src/copy/live/postgres-live-reservations.js';
import { BoundaryPrivyOrderSigningClient } from '../src/copy/live/privy-order-client.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { PostgresLiveUnattemptedRecovery } from '../src/copy/live/postgres-live-unattempted-recovery.js';
import { CopyWalletRepository } from '../src/copy/copy-wallet.repository.js';
import { CopyAgentRepository } from '../src/copy/copy-agent.repository.js';

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
        const state = { marginSummary: sums, crossMarginSummary: sums, crossMaintenanceMarginUsed: '0', withdrawable: '100', time: clock, assetPositions: [] };
        this.emit('message', Buffer.from(JSON.stringify(subscription.type === 'allDexsClearinghouseState'
          ? { channel: subscription.type, data: { user: subscription.user, clearinghouseStates: [['', state]] } }
          : { channel: 'openOrders', data: { user: subscription.user, dex: subscription.dex, orders: [] } })));
      });
    }
    close(code: number) { this.readyState = 3; this.emit('close', code, Buffer.alloc(0)); }
    terminate() { this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)); }
  } };
});

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
const request = (): TestnetLiveExecutionRequest => ({ userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: seed.fill.id, leg: 'open' });
const runtime = (c = config, deployment = options) => new TestnetLiveExecutionRuntime(pool, c, global, budget, deployment, () => clock);
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
async function actualClockFixture(perTradeUsd = 10, accountRevision = 1) {
  // Preserve original source timestamps/consent bindings, rather than restamp
  // proof objects. The genuine fixture is created at the provider/SQL clock.
  clock = Date.now(); const delta = clock - now, date = (value: number) => new Date(value + delta);
  const [version] = await db.select().from(schema.copyStrategyVersions);
  const settings = { ...version!.settings, perTradeUsd };
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
  const meta = { collateralToken: 7, universe: [{ name: 'BTC', szDecimals: 2, maxLeverage: 20 }] };
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
      meta, allPerpMetas: [meta], metaAndAssetCtxs: [meta, [{ midPx: '100', markPx: '100' }]],
      activeAssetData: { user: body.user, coin: 'BTC', leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['1', '1'], availableToTrade: ['100', '100'], markPx: '100' },
      userFees: { userAddRate: '-0.0001', userCrossRate: '0.0005', activeReferralDiscount: '0', trial: null },
      extraAgents: [{ address: agent.address, name: 'dedicated', validUntil: clock + 60000 }], orderStatus: { status: 'unknownOid' } };
    if (!(body.type in values)) throw Error(`Unsupported offline INFO ${body.type}`);
    return Response.json(values[body.type]);
  });
}
describe('unregistered concrete testnet execution runtime', () => {
  it('denies an unconfigured project egress before routing SQL or provider work', async () => {
    config = configuration({ HYPERLIQUID_EGRESS_KEY: undefined });
    const connect = vi.spyOn(pool, 'connect');
    await expect(runtime().execute(request())).rejects.toThrow('hyperliquid_quota_egress_unconfigured');
    expect(connect).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it('rejects a structurally forged transport instead of accepting a caller gate or quota bypass', () => {
    expect(() => new TestnetLiveExecutionRuntime(pool, config, { ...global } as HyperliquidGlobalTransport,
      budget, options)).toThrow('testnet_runtime_dependencies');
  });
  it.each([{ slippageBps: '-1' }, { extraRiskBufferBps: 'NaN' }, { restingOrderBuilderFeeCapTenthsBps: 101 }])('rejects invalid deployment risk settings %j', patch => {
    expect(() => runtime(config, { ...options, ...patch })).toThrow('testnet_runtime_options');
  });
  it('rejects a foreign owner before any network observation or nonce allocation', async () => {
    await expect(runtime().execute({ ...request(), userId: 2 })).rejects.toThrow('testnet_runtime_identity');
    expect(raw).not.toHaveBeenCalled(); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(0);
  });
  it('refuses mainnet configuration even though discovery and global quota support mainnet', async () => {
    await expect(runtime(configuration({ HYPERLIQUID_NETWORK: 'mainnet' })).execute(request())).rejects.toThrow('testnet_runtime_network');
    expect(raw).not.toHaveBeenCalled();
  });
  it('does not treat an expired mandate as admission authority', async () => {
    const expired = new TestnetLiveExecutionRuntime(pool, config, global, budget, options, () => now + 60001);
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
    await db.transaction(tx => new CopyAgentRepository(db).ensure(tx, 1, 'account', { idempotencyKey: 'runtime-replacement-agent', validForDays: 1 }, 'worker'));
    const [grant] = await db.select().from(schema.copyWalletAuthorizations), [event] = await db.select().from(schema.copyWalletAuthorizationEvents);
    expect(grant!.version).toBe(original.authorization.version + 1); expect(event!.version).toBe(grant!.version);
    expect(event!.createdAt.getTime()).toBeLessThanOrEqual(grant!.revokedAt!.getTime());
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
      raw.mockClear(); await expect(runtime().execute(request())).rejects.toThrow('testnet_runtime_historical_identity'); expect(raw).not.toHaveBeenCalled();
    });
  it('waits for a real revoked grant event ahead of the app clock and accepts it only after the read clock catches up', async () => {
    await actualClockFixture(); const original = await runtime(config, { ...options, slippageBps: '0' }).execute(request());
    await revokeHistoricalGrant();
    // Model SQL ahead of app time without restamping the grant or saved order.
    await db.update(schema.copyWalletAuthorizationEvents).set({ createdAt: new Date(clock + 1) });
    raw.mockClear(); await expect(runtime().execute(request())).rejects.toThrow('testnet_runtime_historical_identity');
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
    await expect(runtime().execute(request())).rejects.toThrow('testnet_runtime_reservation_recovery_required');
    expect(raw).not.toHaveBeenCalled(); expect(await db.select().from(schema.copySignerNonces)).toHaveLength(1);
  });
  it('refuses a completed response after the original epoch expires while preserving its terminal journal for read-only recovery', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation(async (url, init) => { const response = await previous(url, init); if (String(url).endsWith('/exchange')) clock += 5001; return response; });
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow('live_risk_stale');
    const [journal] = await db.select().from(schema.copyLiveExecutions); expect(journal?.state).toBe('filled');
    raw.mockClear(); const recovered = await runtime().execute(request()); expect(recovered.state).toBe('filled'); expect(raw).not.toHaveBeenCalled();
  });
  it('does not accept a caller-supplied gate or proof array on an otherwise valid routing request', async () => {
    await expect(runtime().execute({ ...request(), proof: seed.f } as TestnetLiveExecutionRequest)).rejects.toThrow('testnet_runtime_request');
    expect(raw).not.toHaveBeenCalled();
  });
  it('binds the configured worker quorum to the current owner consent before collecting any provider proof', async () => {
    await expect(runtime(configuration({ PRIVY_AGENT_WORKER_QUORUM_ID: 'foreign-worker' })).execute(request())).rejects.toThrow('testnet_runtime_signing_configuration');
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
  it('denies a signed fixed10 budget at nonzero slippage below the provider minimum before SDK or POST', async () => {
    await actualClockFixture();
    const sign = vi.spyOn(BoundaryPrivyOrderSigningClient.prototype, 'signTypedData');
    await expect(runtime().execute(request())).rejects.toThrow('below_min_notional');
    expect(sign).not.toHaveBeenCalled(); expect(raw.mock.calls.some(([url]) => String(url).endsWith('/exchange') || String(url).includes('privy.io'))).toBe(false);
    const [journal] = await db.select().from(schema.copyLiveExecutions);
    expect((journal!.record as unknown as { action: { orders: { s: string; p: string }[] } }).action.orders[0]).toMatchObject({ s: '0.09', p: '100.3' });
    expect(await db.select().from(schema.copyLiveRiskReservations)).toHaveLength(0);
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
    await expect(runtime().execute(request())).rejects.toThrow('testnet_runtime_historical_identity'); expect(raw).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.state).toBe('held');
  });
  it('does not apply a historical revision exception to unexpired held financial admission', async () => {
    await actualClockFixture(); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url) === 'https://api.privy.io/v1/wallets/agent' ? Promise.reject(Error('Pre-sign fault')) : previous(url, init));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow();
    await db.update(schema.copyExecutionAccounts).set({ revision: 2 }); raw.mockClear();
    await expect(runtime().execute(request())).rejects.toThrow('testnet_runtime_historical_identity'); expect(raw).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveRiskReservations))[0]!.state).toBe('held');
  });
  it('rejects a regressed account revision during zero-effect expiry cleanup', async () => {
    await actualClockFixture(10, 2); const previous = raw.getMockImplementation()!;
    raw.mockImplementation((url, init) => String(url) === 'https://api.privy.io/v1/wallets/agent' ? Promise.reject(Error('Pre-sign fault')) : previous(url, init));
    await expect(runtime(config, { ...options, slippageBps: '0' }).execute(request())).rejects.toThrow();
    const [held] = await db.select().from(schema.copyLiveRiskReservations); expect(held!.state).toBe('held');
    await db.update(schema.copyExecutionAccounts).set({ revision: 1 }); clock += 60001; raw.mockClear();
    await expect(runtime().execute(request())).rejects.toThrow('testnet_runtime_historical_identity'); expect(raw).not.toHaveBeenCalled();
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
  async function mainnetFixture(perTradeUsd = 20) {
    await actualClockFixture(perTradeUsd);
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
  const reference = (midPrice: string) => ({ read: vi.fn(async () => ({ midPrice, midObservedAt: clock, leaderEquity: null, leaderEquityObservedAt: null })) });
  const mainnetRuntime = (hooks: ConstructorParameters<typeof TestnetLiveExecutionRuntime>[6]) =>
    new TestnetLiveExecutionRuntime(pool, config, global, budget, mainnetOptions, () => clock, hooks);
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
  it('never takes a testnet fill as a mainnet leader signal', async () => {
    await mainnetFixture();
    await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'testnet' });
    await expect(mainnetRuntime({ reference: reference('100') }).execute(request())).rejects.toThrow();
    expect(await db.select().from(schema.copyLiveExecutions)).toHaveLength(0);
  });
});

