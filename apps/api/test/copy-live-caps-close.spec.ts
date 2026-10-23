import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { appSettings, copyLiveMandates, copyLiveSourceFills, copyLiveSourceStreams, copyStrategies, copyStrategyVersions } from '@trading-dashboard/shared/database';
import type { LiveCopyConfig } from '../src/config/runtime-config.js';
import { registerLiveDeployment } from '../src/copy/live-deployment.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { loadLivePreparationAuthority } from '../src/copy/live/postgres-live-risk-authority.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Safety exits: the deployment's caps and owner allowlist bound new risk.
// Tightened while a copy runs, they refuse its opens and adds, never the
// reduce-only closes of its generation (which would strand its positions).
let db: TestDb, pool: Pool, seed: Awaited<ReturnType<typeof preparationFixture>>;
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }); });
beforeEach(async () => { seed = await preparationFixture(db); });
afterEach(() => { registerLiveDeployment(undefined); });
afterAll(async () => { await pool.end(); await closeTestDb(); });

const live = (over: Partial<LiveCopyConfig>): LiveCopyConfig => ({ network: 'testnet', caps: { maxStrategiesPerUser: 2 }, builderFee: true, testnetSourceIntervalMs: 60_000,
  maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300, ...over });
async function authority(leg?: 'open' | 'close') {
  const scope = new PostgresLiveRiskScope(pool, () => now);
  return scope.run({ userId: 1, network: 'testnet', accountAddress: seed.f.identity.accountAddress, source: { network: 'testnet', leaderAddress: seed.consent.leaderAddress } },
    async (_scope, session) => session.read(tx => loadLivePreparationAuthority(session, tx, { accountId: 'account', mandateId: 'mandate', ...(leg ? { leg } : {}) }, now)));
}

describe('tightened caps refuse a running copy\'s opens, not its closes', () => {
  it.each([
    ['live_risk_budget_above_cap', live({ caps: { maxStrategiesPerUser: 2, maxAllocationUsd: 50 } })],
    ['live_risk_sizing_above_cap', live({ caps: { maxStrategiesPerUser: 2, ratioOnly: true } })],
    ['live_risk_sizing_above_cap', live({ caps: { maxStrategiesPerUser: 2, fixedPerTradeUsd: { min: 500, max: 600 } } })],
    ['live_risk_owner_not_allowed', live({ allowedPrivyUserIds: new Set(['did:privy:someone-else']) })],
    // The copy's settings allow 10x.
    ['live_risk_leverage_above_cap', live({ caps: { maxStrategiesPerUser: 2, maxLeverage: 1 } })],
    ['live_risk_strategy_cap', live({ caps: { maxStrategiesPerUser: 0 } })],
  ] as const)('%s: an open (or an order of unknown leg) is refused; a close passes', async (code, deployment) => {
    // Within every cap: both pass, and the authority is the same.
    const before = await authority('close');
    registerLiveDeployment(deployment);
    await expect(authority('open')).rejects.toThrow(code);
    await expect(authority()).rejects.toThrow(code);
    const close = await authority('close');
    expect(close.account.id).toBe('account');
    expect(close.mandate.id).toBe(before.mandate.id);
  });

  it.each([
    ['the owner paused the copy', 'live_risk_mandate_changed', async () => {
      await db.update(copyStrategies).set({ status: 'paused', pauseNewRisk: true });
      await db.update(copyLiveMandates).set({ state: 'paused' });
    }],
    ['copy trading is switched off', 'live_risk_platform_disabled', async () => {
      await db.update(appSettings).set({ value: { copyTradingEnabled: false } }).where(eq(appSettings.key, 'general'));
    }],
  ] as const)('%s: an open (or an order of unknown leg) is refused; a close passes', async (_control, code, apply) => {
    await apply();
    await expect(authority('open')).rejects.toThrow(code);
    await expect(authority()).rejects.toThrow(code);
    expect((await authority('close')).account.id).toBe('account');
  });

  it('D10: the leader\'s stream in gap admits a close, not an open (live_risk_source_not_ready, a wait); unproven or quarantined it admits neither', async () => {
    await db.update(copyLiveSourceStreams).set({ state: 'gap', lastIssue: 'source_unavailable' });
    await expect(authority('open')).rejects.toThrow('live_risk_source_not_ready');
    await expect(authority()).rejects.toThrow('live_risk_source_not_ready');
    expect((await authority('close')).sourceStream).toMatchObject({ state: 'gap' });
    for (const state of ['unproven', 'quarantined'] as const) {
      await db.update(copyLiveSourceStreams).set({ state });
      await expect(authority('close')).rejects.toThrow('live_risk_source_not_ready');
    }
    // Coverage that starts after the copy's cursor is a change, not a wait, for a close too (the database admits no gap without coverage).
    await db.update(copyLiveSourceStreams).set({ state: 'gap', coverageFrom: new Date(now - 1000) });
    await expect(authority('close')).rejects.toThrow('live_risk_source_changed');
    // No stream row for the leader at all (never ingested): a change, as before D10, for every leg.
    await db.delete(copyLiveSourceFills); await db.delete(copyLiveSourceStreams);
    for (const leg of ['open', 'close', undefined] as const) await expect(authority(leg)).rejects.toThrow('live_risk_source_changed');
  });

  it('a revoked or stopping copy still refuses a close here (its own stop closes it)', async () => {
    await db.update(copyLiveMandates).set({ state: 'revoked' });
    await expect(authority('close')).rejects.toThrow('live_risk_mandate_changed');
    await db.update(copyLiveMandates).set({ state: 'active' });
    await db.update(copyStrategies).set({ status: 'stopping' });
    await expect(authority('close')).rejects.toThrow('live_risk_mandate_changed');
  });

  it('only the caps and the allowlist: every other check still refuses a close (another network\'s deployment, a changed mandate)', async () => {
    registerLiveDeployment(live({ network: 'mainnet' }));
    await expect(authority('close')).rejects.toThrow('live_risk_deployment_unproven');
    registerLiveDeployment(undefined);
    const [version] = await db.select().from(copyStrategyVersions);
    await db.update(copyStrategyVersions).set({ settings: { ...version!.settings, maxLeverage: 3 } });
    await expect(authority('close')).rejects.toThrow('live_risk_mandate_changed');
  });
});
