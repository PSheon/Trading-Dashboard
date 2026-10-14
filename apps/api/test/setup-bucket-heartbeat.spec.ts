import { describe, expect, it, vi } from 'vitest';
import { adminSystemSchema, heartbeatResponseSchema, wireHeartbeatSchema } from '@trading-dashboard/shared/contracts';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import type { WorkerFleetService } from '../src/api/health/worker-fleet.service.js';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import type { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { walletNetworkHyperliquid } from '../src/hyperliquid/wallet-network-hyperliquid.js';
import { WorkerHeartbeatService } from '../src/worker/worker-heartbeat.service.js';

// c2581938 gave copy setups' steps a local bucket of their own
// (WalletNetworkHyperliquid.setupBudget) beside the order bucket; the
// heartbeat showed only the order bucket (walletBudget). Both are shown now.
const config = (env: Record<string, string>) => new AppConfig(validateEnvironment({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', NODE_ENV: 'test', HYPERLIQUID_EGRESS_KEY: 'egress', IS_WORKER: 'true', ...env }));
const quota = Object.create(PostgresHyperliquidQuota.prototype) as PostgresHyperliquidQuota;
const watcher = { getHeartbeat: () => ({ feed: { socketsTotal: 1, socketsOpen: 1, markets: 1, disconnectedSince: null, lastTradeAt: null }, lastFillAt: null, lastSweepAt: null, fillsUnavailable: [] }) };

describe('the setup bucket in the heartbeat and the admin overview', () => {
  it('a testnet wallet network: setupBudget beside walletBudget, with its own tokens and queue', async () => {
    const cfg = config({ HYPERLIQUID_NETWORK: 'testnet' }), main = new RequestBudgeterService(cfg);
    const wallet = walletNetworkHyperliquid(cfg, main, {} as HyperliquidGlobalTransport, quota);
    vi.spyOn(wallet.transport, 'laneStatus').mockResolvedValue(undefined);
    try {
      // A setup's account-mode step spent 715 of its bucket; the order bucket is untouched.
      wallet.setupBudget.adjust(715);
      const beat = await new WorkerHeartbeatService(cfg, watcher as never, null, main, undefined, undefined, wallet).heartbeat();
      const parsed = heartbeatResponseSchema.parse(beat);
      expect(parsed.walletBudget).toMatchObject({ network: 'testnet', tokensAvailable: 900, queued: { live: 0, background: 0 } });
      expect(parsed.setupBudget).toMatchObject({ network: 'testnet', effectivePerMin: 300, queued: { live: 0, background: 0 } });
      expect(parsed.setupBudget!.tokensAvailable).toBe(900 - 715);
      expect(wireHeartbeatSchema.parse(JSON.parse(JSON.stringify(beat))).setupBudget?.tokensAvailable).toBe(185);
      // The api process's own setup bucket (it drives setups under API_SETUP_DRIVE=local).
      const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue(null), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockResolvedValue(null) };
      const fleet = { monitors: async () => ({ worker: { state: 'not_configured', sample: null } }), alerts: () => [] } as unknown as WorkerFleetService;
      const overview = adminSystemSchema.parse(await new AdminSystemService(repository as never, cfg, main, fleet, wallet).overview());
      expect(overview.api.setupBudget).toMatchObject({ network: 'testnet', tokensAvailable: 185, queued: { live: 0, background: 0 } });
    } finally { main.onModuleDestroy(); wallet.budget.onModuleDestroy(); wallet.setupBudget.onModuleDestroy(); }
  });

  it('a wallet network whose setups share the one budget shows no separate setup bucket', async () => {
    const cfg = config({ HYPERLIQUID_NETWORK: 'mainnet' }), main = new RequestBudgeterService(cfg);
    const wallet = walletNetworkHyperliquid(cfg, main, { laneStatus: async () => undefined } as unknown as HyperliquidGlobalTransport, quota);
    try {
      expect(wallet.setupBudget).toBe(wallet.budget);
      const beat = await new WorkerHeartbeatService(cfg, watcher as never, null, main, undefined, undefined, wallet).heartbeat();
      expect(beat.setupBudget).toBeUndefined();
    } finally { main.onModuleDestroy(); }
  });
});
