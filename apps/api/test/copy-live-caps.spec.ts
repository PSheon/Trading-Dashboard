import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminSettingsSchema, DEFAULT_COPY_RISK_LIMITS } from '@trading-dashboard/shared/contracts';
import { appSettings, copyControls, copyRiskPolicies } from '@trading-dashboard/shared/database';
import type { AppConfig } from '../src/config/app-config.js';
import type { LiveCopyConfig } from '../src/config/runtime-config.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { liveMaxStrategiesPerUser } from '../src/copy/live-worker/copy-live-engine.provider.js';
import { assertLiveEvidenceCapacity } from '../src/copy/live/live-shared-reads.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, openCopyTrading, truncateAll, type TestDb } from './db-test-utils.js';

/**
 * The deployment's caps (COPY_LIVE_*) apply as the stricter of the env value
 * and the risk policy: Stage's policy v1 (10 copies, 100,000 USDC) can't be
 * changed tonight, so a mainnet Stage must hold Paul to 2 copies of at most
 * 50 USDC each, fixed 12–15 USDC a trade, leverage 3, and only his account.
 */
let db: TestDb, uid: number;
const paul = 'did:privy:paul-mainnet';
const live = (caps: Partial<LiveCopyConfig['caps']> = {}): LiveCopyConfig => ({ network: 'mainnet', allowedPrivyUserIds: new Set([paul]), builderFee: false, testnetSourceIntervalMs: 60_000,
  maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300,
  caps: { maxStrategiesPerUser: 2, maxAllocationUsd: 50, fixedPerTradeUsd: { min: 12, max: 15 }, maxLeverage: 3, ...caps } });
/** A deployment on `network`, with these live settings (none: paper, today's behaviour). */
const deployment = (settings: LiveCopyConfig | undefined, network: 'testnet' | 'mainnet' = settings?.network ?? 'testnet'): AppConfig => {
  const base = testConfig();
  return { get value() { const v = base.value; return { ...v, hyperliquid: { ...v.hyperliquid, wallet: { ...v.hyperliquid.wallet, network } },
    copy: { ...v.copy, ...(settings ? { mode: settings.network === 'mainnet' ? 'live' : 'testnet', live: settings } : {}) } }; } } as unknown as AppConfig;
};
const settings = (patch: Record<string, unknown> = {}) => ({ direction: 'same' as const, sizingMode: 'fixed' as const, perTradeUsd: 12, maxTotalExposureUsd: null, maxLeverage: 3,
  copyStartMode: 'delta' as const, ...patch });
const leader = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(20)}`;
const create = (config: AppConfig, n: number, patch: { budgetUsd?: string; settings?: Record<string, unknown>; sourceNetwork?: 'testnet' | 'mainnet' } = {}, userId = uid) =>
  new UnitOfWork(db).run(tx => new CopyLiveMandateRepository(db, config).create(tx, userId, { idempotencyKey: `caps-${config.value.hyperliquid.wallet.network}-key-${String(n).padStart(4, '0')}`, leader: leader(n),
    sourceNetwork: patch.sourceNetwork ?? 'mainnet', budgetUsd: patch.budgetUsd ?? '50', settings: settings(patch.settings) as never }, () => Date.now()));
const refusal = (code: string) => ({ response: expect.objectContaining({ code }) });

beforeEach(async () => {
  db = getTestDb(); await truncateAll(db);
  uid = (await insertUser(db, { privyUserId: paul, embeddedWalletAddress: `0x${'55'.repeat(20)}` })).id;
  await openCopyTrading(db);
  await db.insert(copyControls).values([{ scope: 'platform', scopeId: 0 }, { scope: 'user', scopeId: uid }]);
  await db.insert(appSettings).values({ key: 'revenue', value: adminSettingsSchema.shape.revenue.parse({}) });
  // Stage's policy v1: looser than the deployment on every cap.
  await db.insert(copyRiskPolicies).values({ limits: { ...DEFAULT_COPY_RISK_LIMITS, maxStrategiesPerUser: 10, maxAllocationUsd: 100_000, minAllocationUsd: 100, maxLeverage: 10 },
    reason: 'stage v1', createdByUserId: uid });
});
afterAll(async () => { await closeTestDb(); });

describe('deployment caps on actual copies', () => {
  it('policy 10 copies with COPY_LIVE_MAX_STRATEGIES_PER_USER=2: the mainnet worker boots, and a third copy is refused', async () => {
    const max = await liveMaxStrategiesPerUser(db, live().caps);
    expect(max).toBe(2);
    // The mainnet worker's order bucket (360/min, burst 840: capacity 840) holds 2 accounts + the leader.
    expect(assertLiveEvidenceCapacity({ capacity: 840, maxStrategiesPerUser: max, network: 'mainnet', budgetPerMin: 360 })).toMatchObject({ users: 3 });
    expect(() => assertLiveEvidenceCapacity({ capacity: 840, maxStrategiesPerUser: 10, network: 'mainnet', budgetPerMin: 360 })).toThrow();
    const config = deployment(live());
    await create(config, 1); await create(config, 2);
    await expect(create(config, 3)).rejects.toMatchObject(refusal('strategy_limit'));
  });

  it('a budget of 60 is refused under COPY_LIVE_MAX_ALLOCATION_USD=50 (and 50 passes despite the policy minimum of 100)', async () => {
    const config = deployment(live());
    await expect(create(config, 1, { budgetUsd: '60' })).rejects.toMatchObject(refusal('above_max_allocation'));
    await expect(create(config, 1, { budgetUsd: '50' })).resolves.toMatchObject({ budgetUsd: '50', network: 'mainnet' });
  });

  it('fixed sizing only, 12–15 USDC a trade, leverage at most 3', async () => {
    const config = deployment(live());
    for (const perTradeUsd of [11, 15.5, 100]) await expect(create(config, 1, { settings: { perTradeUsd } })).rejects.toMatchObject(refusal('live_per_trade_out_of_range'));
    await expect(create(config, 1, { settings: { sizingMode: 'ratio', perTradeUsd: null } })).rejects.toMatchObject(refusal('live_fixed_sizing_required'));
    await expect(create(config, 1, { settings: { maxLeverage: 5 } })).rejects.toMatchObject(refusal('leverage_above_limit'));
    await expect(create(config, 1, { settings: { perTradeUsd: 15 } })).resolves.toMatchObject({ settings: expect.objectContaining({ sizingMode: 'fixed', perTradeUsd: 15 }) });
  });

  it('refuses an owner outside COPY_LIVE_ALLOWED_PRIVY_USER_IDS, and a testnet leader on a mainnet deployment', async () => {
    const other = (await insertUser(db, { privyUserId: 'did:privy:someone-else', embeddedWalletAddress: `0x${'66'.repeat(20)}` })).id;
    await db.insert(copyControls).values({ scope: 'user', scopeId: other });
    await expect(create(deployment(live()), 1, {}, other)).rejects.toMatchObject(refusal('live_not_allowed'));
    await expect(create(deployment(live()), 2, { sourceNetwork: 'testnet' })).rejects.toMatchObject(refusal('live_source_network_unsupported'));
  });

  it("another network's copies neither count against the cap nor block the same leader", async () => {
    // Paul's testnet copy of leader 1, still active on the old network.
    await create(deployment(undefined), 1, { budgetUsd: '200', sourceNetwork: 'testnet' });
    const config = deployment(live());
    await expect(create(config, 1)).resolves.toMatchObject({ network: 'mainnet' });
    await expect(create(config, 2)).resolves.toMatchObject({ network: 'mainnet' });
    await expect(create(config, 3)).rejects.toMatchObject(refusal('strategy_limit'));
  });

  it("with the caps unset (no live settings), today's behaviour is unchanged", async () => {
    const config = deployment(undefined);
    expect(await liveMaxStrategiesPerUser(db, { maxStrategiesPerUser: 10 })).toBe(10);
    await expect(create(config, 1, { budgetUsd: '60', sourceNetwork: 'testnet' })).rejects.toMatchObject(refusal('below_min_allocation'));
    for (const n of [1, 2, 3]) await expect(create(config, n, { budgetUsd: '1000', sourceNetwork: 'testnet', settings: { sizingMode: 'ratio', perTradeUsd: null, maxLeverage: 8 } }))
      .resolves.toMatchObject({ network: 'testnet', budgetUsd: '1000' });
  });
});
