import { Logger, type Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { AppConfig } from '../../config/app-config.js';
import { DATABASE_POOL, type DrizzleDb } from '../../db/drizzle.provider.js';
import { DRIZZLE_CLIENT } from '../../db/db.constants.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { randomUUID } from 'node:crypto';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../../hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../../hyperliquid/request-budgeter.service.js';
import { CopyMarketService } from '../copy-market.service.js';
import { HyperliquidLiveSourceClient } from '../copy-live-source.client.js';
import { CopyLiveSourceRepository } from '../copy-live-source.repository.js';
import { CopyFollowerLedger } from '../live/copy-follower-ledger.js';
import { HyperliquidFollowerReceiptReader } from '../live/follower-receipt-reader.js';
import { CopyFollowerReconciler } from '../copy-follower-monitor.service.js';
import { CopyFollowerScanRepository } from '../copy-follower-scan.repository.js';
import { CopyLiveReturnRepository } from '../copy-live-return.repository.js';
import { MainnetSourceReferenceReader } from '../live/live-source-reference.js';
import { TestnetLiveExecutionRuntime } from '../live/testnet-live-execution-runtime.js';
import { CopyLiveEngine, DEFAULT_ENGINE_OPTIONS } from './copy-live-engine.js';
import { CopyLiveSettler } from './copy-live-settler.js';
import { CopyLiveWorkerRepository } from './copy-live-worker.repository.js';
import { WatchedMainnetSource } from './watched-mainnet-source.js';
import { CopyLiveStopWorkerRepository } from './copy-live-stop-worker.repository.js';
import { CopyLiveManualCloser, CopyLiveStopper, StopCanceller } from './copy-live-stopper.js';
import { TestnetReduceOnlyCloser } from './reduce-only-closer.js';

export const LIVE_ENGINE = Symbol('LIVE_ENGINE');
/** Risk inputs the runtime requires besides slippage and the price check. */
const EXTRA_RISK_BUFFER_BPS = '5', RESTING_BUILDER_FEE_CAP_TENTHS_BPS = 100;

/** Builds the engine from the worker's concrete dependencies. Null unless
 * COPY_TRADING_MODE=testnet (whose prerequisites startup already checked). */
export const liveEngineProvider: Provider = {
  provide: LIVE_ENGINE,
  inject: [AppConfig, DATABASE_POOL, DRIZZLE_CLIENT, UnitOfWork, PostgresHyperliquidQuota, CopyMarketService, CopyFollowerLedger,
    CopyLiveSourceRepository, CopyLiveWorkerRepository, CopyFollowerScanRepository, CopyLiveStopWorkerRepository, CopyLiveReturnRepository],
  useFactory: (config: AppConfig, pool: Pool, db: DrizzleDb, uow: UnitOfWork, quota: PostgresHyperliquidQuota,
    market: CopyMarketService, ledger: CopyFollowerLedger, sources: CopyLiveSourceRepository, repository: CopyLiveWorkerRepository, scans: CopyFollowerScanRepository, stops: CopyLiveStopWorkerRepository, returns: CopyLiveReturnRepository): CopyLiveEngine | null => {
    const live = config.value.copy.live;
    if (config.value.copy.mode !== 'testnet' || !live) return null;
    const logger = new Logger('CopyLiveEngine');
    // Testnet execution reads go to a separate host with its own per-IP
    // limit: their own token bucket and shared egress key, so they neither
    // starve nor are starved by the mainnet watcher's budget.
    const hl = config.value.hyperliquid, egressKey = `${hl.egressKey}:testnet`;
    const testnetConfig = new AppConfig({ ...config.value, hyperliquid: { ...hl, egressKey, budgetPerMin: live.weightPerMin, burst: 1200 - live.weightPerMin, startupPaceSeconds: 0 } });
    const testnetBudget = new RequestBudgeterService(testnetConfig);
    const testnetGlobal = new HyperliquidGlobalTransport(quota, { egressKey, ownerId: randomUUID() });
    const reference = new MainnetSourceReferenceReader(market);
    const options = { slippageBps: String(live.slippageBps), extraRiskBufferBps: EXTRA_RISK_BUFFER_BPS,
      restingOrderBuilderFeeCapTenthsBps: RESTING_BUILDER_FEE_CAP_TENTHS_BPS, maxSourceDeviationBps: String(live.maxSourceDeviationBps) };
    const scanner = new CopyFollowerReconciler(scans, ledger,
      new HyperliquidFollowerReceiptReader('testnet', weight => testnetBudget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) }), testnetGlobal.fetchInfo));
    const closer = new TestnetReduceOnlyCloser(pool, db, uow, testnetConfig, testnetGlobal, testnetBudget, Math.max(100, live.slippageBps * 3));
    const stopper = new CopyLiveStopper({ repository: stops, closer, log: message => logger.warn(message), revokeDeadlineMs: live.revokeDeadlineMs,
      canceller: new StopCanceller(pool, db, testnetConfig, testnetGlobal, testnetBudget, stops, (account, key) => closer.reconcile(account, key)),
      // Returning funds to the main wallet is the owner's signed transfer; the
      // stop ends once that sweep is credited.
      swept: stop => returns.swept(stop.id) });
    const manual = new CopyLiveManualCloser(stops, closer, scanner, message => logger.warn(message));
    return new CopyLiveEngine({ stopper: { tick: async () => { await stopper.tick(); await manual.tick(); } },
      repository, sources, uow, watched: new WatchedMainnetSource(db),
      testnetSource: new HyperliquidLiveSourceClient('testnet', weight => testnetBudget.acquire(weight, 'live', undefined, { signal: AbortSignal.timeout(5000) }), testnetGlobal.fetchInfo),
      runtime: hooks => new TestnetLiveExecutionRuntime(pool, testnetConfig, testnetGlobal, testnetBudget, options, Date.now, { ...hooks, reference }),
      settler: new CopyLiveSettler(pool, testnetGlobal, testnetBudget, scanner),
      log: message => logger.warn(message),
    }, DEFAULT_ENGINE_OPTIONS);
  },
};
