import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { testConfig } from './config-test-utils.js';
import { DATABASE_POOL } from '../src/db/drizzle.provider.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { WALLET_NETWORK_HL } from '../src/hyperliquid/wallet-network-hyperliquid.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { apiSettlementProvider } from '../src/copy/live-worker/copy-live-api-settlement.provider.js';
import { CopyLiveSettler } from '../src/copy/live-worker/copy-live-settler.js';
import { CopyLiveApiSettlementService } from '../src/copy/live-worker/copy-live-api-settlement.service.js';
import { liveEngineProvider } from '../src/copy/live-worker/copy-live-engine.provider.js';
const configFor = (worker: boolean) => new AppConfig({ ...testConfig().value, app: { ...testConfig().value.app, isWorker: worker },
  hyperliquid: { ...testConfig().value.hyperliquid, egressKey: 'offline', budgetPerMin: 400, burst: 800 },
  copy: { ...testConfig().value.copy, live: { network: 'testnet', caps: { maxStrategiesPerUser: 1 }, builderFee: true,
    intervalMs: 3000, testnetSourceIntervalMs: 60000, maxSourceDeviationBps: 500, slippageBps: 30, weightPerMin: 400 } } });
describe('production process composition for terminal settlement', () => {
  it('API module provider uses existing wallet dependencies and bootstrapping in tests starts no real work', async () => {
    const pool = new Pool(), connect = vi.spyOn(pool, 'connect');
    const module = await Test.createTestingModule({ providers: [apiSettlementProvider,
      { provide: AppConfig, useValue: configFor(false) }, { provide: DATABASE_POOL, useValue: pool },
      { provide: WALLET_NETWORK_HL, useValue: { network: 'testnet', budget: {}, transport: {} } }, BackgroundJobs] }).compile();
    try {
      await module.init(); expect(module.get(CopyLiveApiSettlementService)).toBeInstanceOf(CopyLiveApiSettlementService);
      // No signer/executor provider is supplied or resolved by this composition.
      expect(connect).not.toHaveBeenCalled();
    } finally { await module.close(); await pool.end(); }
  });
  it.each(['worker', 'mainnet', 'disabled'])('does not admit API settlement in %s composition', async role => {
    const c = configFor(role === 'worker');
    const config = new AppConfig({ ...c.value, hyperliquid: { ...c.value.hyperliquid, wallet: { ...c.value.hyperliquid.wallet, network: role === 'mainnet' ? 'mainnet' : 'testnet' } },
      copy: { ...c.value.copy, live: role === 'disabled' ? undefined : c.value.copy.live } });
    const candidates = vi.fn();
    const api = new CopyLiveApiSettlementService(config, new BackgroundJobs(), { candidates } as never, {} as never, () => { throw Error('unexpected provider construction'); });
    await api.tick(); expect(candidates).not.toHaveBeenCalled(); api.onModuleDestroy();
  });
  it('real worker provider fixes API handoff on for testnet without an environment or payload toggle', async () => {
    const config = configFor(true), pool = new Pool(), budget = new RequestBudgeterService(config);
    const db = { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) };
    const uow = new UnitOfWork(db as never), global = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow), { egressKey: 'offline:testnet', ownerId: 'offline' });
    const connect = vi.spyOn(pool, 'connect'), update = vi.fn();
    const settle = vi.spyOn(CopyLiveSettler.prototype, 'settle').mockResolvedValue({ kind: 'released' });
    try {
      const engine = await liveEngineProvider.useFactory(config, pool, db, uow, {}, {}, {}, { journalState: async () => 'filled', update }, {}, {}, {}, {},
        { network: 'testnet', budget, transport: global, config }, {}, {}, {});
      await engine!.work({ state: 'submitted', mandateId: 'm', sourceFillId: 'f', leg: 'open', executionKey: 'key' } as never,
        { accountAddress: `0x${'11'.repeat(20)}` } as never, 120000);
      expect(connect).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
    } finally { settle.mockRestore(); budget.onModuleDestroy(); await pool.end(); }
  });
});
