import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/app-config.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyFollowerScanRepository } from '../src/copy/copy-follower-scan.repository.js';
import { CopyFollowerSnapshotRepository } from '../src/copy/copy-follower-snapshot.repository.js';
import { CopyLiveReturnRepository } from '../src/copy/copy-live-return.repository.js';
import { CopyLiveSetupRepository } from '../src/copy/copy-live-setup.repository.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import type { LiveExecutionRequest } from '../src/copy/live/live-execution-runtime.js';
import { CopyLiveAutoReturn } from '../src/copy/live-worker/copy-live-auto-return.js';
import { CopyLiveEngine } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveStopWorkerRepository } from '../src/copy/live-worker/copy-live-stop-worker.repository.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import { testConfig } from './config-test-utils.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

/**
 * One network per deployment (workstream ②): Stage's database keeps its
 * testnet copies when the deployment moves to HYPERLIQUID_NETWORK=mainnet.
 * Those rows stay readable history; no worker or api path works, signs or
 * sends anything for them.
 */
let db: TestDb, seed: Awaited<ReturnType<typeof preparationFixture>>;
const deployedOn = (network: 'testnet' | 'mainnet'): AppConfig => {
  const base = testConfig();
  return { get value() { const v = base.value; return { ...v, hyperliquid: { ...v.hyperliquid, wallet: { ...v.hyperliquid.wallet, network } } }; } } as AppConfig;
};

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db);
  // A running testnet copy: activated before the leader's fill, funded.
  await db.update(schema.copyLiveMandates).set({ activationCursor: new Date(now - 5_000), createdAt: new Date(now - 6_000) });
  await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'activated', controlRevision: 0,
    requestedAt: new Date(now - 6_000), activatedAt: new Date(now - 5_000) });
});
afterAll(async () => { await closeTestDb(); });

function engine(network: 'testnet' | 'mainnet', calls: { runtime: LiveExecutionRequest[]; settled: unknown[]; setups: number; stops: number }) {
  const config = deployedOn(network);
  return new CopyLiveEngine({
    network, repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db), config), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db, () => now),
    testnetSource: { read: vi.fn(async () => null) } as never,
    runtime: () => ({ execute: async request => { calls.runtime.push(request); return { key: `${network}:x`, state: 'filled' } as LiveExecutionRecord; } }),
    settler: { settle: async request => { calls.settled.push(request); return { kind: 'released' as const }; } },
    setups: { tick: async () => { calls.setups++; return 0; } },
    stopper: { tick: async () => { calls.stops++; } },
  }, { testnetSourceIntervalMs: 60_000, sourceLagMs: 0, passBudgetMs: 60_000 }, () => now);
}

describe('a testnet copy in a database whose deployment moved to mainnet', () => {
  it('is never worked, signed or sent: no generation, leg, order, settlement, stop, setup, snapshot or scan of it is picked up', async () => {
    const mainnet = deployedOn('mainnet');
    // A stop, a confirmed setup and a funded deposit of the testnet copy, all open.
    await db.insert(schema.copyLiveStopOperations).values({ id: '00000000-0000-4000-8000-000000000001', userId: 1, strategyId: 9, accountId: 'account', mandateId: 'mandate',
      idempotencyKey: 'stop-key-00000001', originalMandateRevision: 2, network: 'testnet', accountAddress: seed.f.identity.accountAddress, ownerPrivyUserId: 'did:privy:risk-source',
      ownerAddress: `0x${'55'.repeat(20)}`, accountWalletId: 'master', accountOwnerQuorumId: 'owner', originalIntentDigest: 'a'.repeat(64), originalConsentDigest: 'b'.repeat(64),
      state: 'requested', targetManifest: {}, targetDigest: 'c'.repeat(64), trackedExecutionCount: 0, trackingComplete: true, createdAt: new Date(now), updatedAt: new Date(now) });
    await db.insert(schema.copyLiveSetups).values({ id: '00000000-0000-4000-8000-000000000002', userId: 1, strategyId: 9, accountId: 'account', kind: 'edit', idempotencyKey: 'setup-key-0000000001',
      stage: 'funded', leaderAddress: seed.consent.leaderAddress, sourceNetwork: 'testnet', budgetUsd: '100', settings: {}, intentDigest: 'd'.repeat(64), consentDigest: 'e'.repeat(64),
      confirmedAt: new Date(now), setupDeadline: new Date(now + 3_600_000) });

    const calls = { runtime: [] as LiveExecutionRequest[], settled: [] as unknown[], setups: 0, stops: 0 };
    await engine('mainnet', calls).tick();
    expect(calls.runtime).toEqual([]);
    expect(calls.settled).toEqual([]);
    expect(await db.select().from(schema.copyLiveDispatches)).toEqual([]);
    expect(await new CopyLiveWorkerRepository(db, new UnitOfWork(db), mainnet).mandates(now)).toEqual([]);
    expect(await new CopyLiveWorkerRepository(db, new UnitOfWork(db), mainnet).mandate('mandate')).toBeNull();
    // The stopper, the setup driver, the snapshot collector and the receipt scan see none of it.
    expect(await new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), mainnet).open()).toEqual([]);
    expect(await new CopyLiveSetupRepository(db).open(new Date(now + 60_000), 'mainnet')).toEqual([]);
    expect(await new CopyFollowerSnapshotRepository(db, mainnet).claim()).toBeNull();
    expect(await new CopyFollowerScanRepository(db, mainnet).claim()).toBeNull();
    // The automatic return refuses the account before anything is signed or sent.
    const signer = { available: true, sign: vi.fn() }, exchange = { send: vi.fn() };
    const stop = (await db.select().from(schema.copyLiveStopOperations))[0]!;
    await db.update(schema.copyExecutionAccounts).set({ masterPolicyId: 'policy', masterPolicyFingerprint: 'f'.repeat(64), masterSignerQuorumId: 'worker',
      sweepDestination: `0x${'55'.repeat(20)}`, signerAttachedAt: new Date(now) });
    await expect(new CopyLiveAutoReturn('mainnet', new CopyLiveReturnRepository(db, mainnet), exchange as never, signer as never, () => now).sweep(stop, '10'))
      .rejects.toThrow();
    expect(signer.sign).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
    expect(await db.select().from(schema.copyFundingOperations)).toEqual([]);
    // Nothing about the testnet copy changed: readable history.
    expect((await db.select().from(schema.copyLiveMandates))[0]).toMatchObject({ state: 'active', network: 'testnet' });
    expect((await db.select().from(schema.copyLiveStopOperations))[0]).toMatchObject({ state: 'requested', revision: 1 });

    // The same rows on a testnet deployment are worked (the fixture is live).
    await engine('testnet', calls).tick();
    expect(calls.runtime).toHaveLength(1);
    expect(calls.runtime[0]).toMatchObject({ mandateId: 'mandate', sourceFillId: seed.fill.id, leg: 'open' });
    expect(await new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), deployedOn('testnet')).open()).toHaveLength(1);
    expect(await new CopyLiveSetupRepository(db).open(new Date(now + 60_000), 'testnet')).toHaveLength(1);
  });
});
