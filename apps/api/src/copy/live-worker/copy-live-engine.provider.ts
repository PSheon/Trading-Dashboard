import { Logger, type Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { AppConfig } from '../../config/app-config.js';
import { DATABASE_POOL, type DrizzleDb } from '../../db/drizzle.provider.js';
import { DRIZZLE_CLIENT } from '../../db/db.constants.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { desc } from 'drizzle-orm';
import { copyRiskPolicies } from '@trading-dashboard/shared/database';
import { copyRiskLimitsSchema } from '@trading-dashboard/shared/contracts';
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from '../../hyperliquid/wallet-network-hyperliquid.js';
import { liveBudget } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { assertLiveEvidenceCapacity } from '../live/live-shared-reads.js';
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
import { CopyLiveAutoReturn } from './copy-live-auto-return.js';
import { CopyFundingExchangeClient } from '../copy-funding-exchange.client.js';
import { PrivyPolicyMasterSigner } from '../live/privy-policy-master-signer.js';
import { CopyLiveSetupService } from '../copy-live-setup.service.js';
import { HyperliquidInfoClient, twapSliceToFill } from '../../hyperliquid/hyperliquid-info.client.js';
import { TradeFeedService } from '../../watcher/trade-feed.service.js';
import { FastMainnetSource } from './fast-mainnet-source.js';

export const LIVE_ENGINE = Symbol('LIVE_ENGINE');
/** Risk inputs the runtime requires besides slippage and the price check. */
const EXTRA_RISK_BUFFER_BPS = '5', RESTING_BUILDER_FEE_CAP_TENTHS_BPS = 100;

/** The copies one owner may hold (the newest explicit risk policy); 1 when
 * there is none yet (live copies need one, and any owner has at least one). */
async function maxStrategiesPerUser(db: DrizzleDb): Promise<number> {
  const [row] = await db.select({ limits: copyRiskPolicies.limits }).from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(1);
  const parsed = row ? copyRiskLimitsSchema.safeParse(row.limits) : undefined;
  return parsed?.success ? parsed.data.maxStrategiesPerUser : 1;
}

/** Builds the engine from the worker's concrete dependencies. Null unless
 * COPY_TRADING_MODE=testnet (whose prerequisites startup already checked).
 * Refuses startup when one order's evidence can't fit the order bucket
 * (assertLiveEvidenceCapacity). */
export const liveEngineProvider: Provider = {
  provide: LIVE_ENGINE,
  inject: [AppConfig, DATABASE_POOL, DRIZZLE_CLIENT, UnitOfWork, CopyMarketService, CopyFollowerLedger,
    CopyLiveSourceRepository, CopyLiveWorkerRepository, CopyFollowerScanRepository, CopyLiveStopWorkerRepository, CopyLiveReturnRepository, CopyLiveSetupService, WALLET_NETWORK_HL,
    HyperliquidInfoClient, { token: TradeFeedService, optional: true }],
  useFactory: async (config: AppConfig, pool: Pool, db: DrizzleDb, uow: UnitOfWork,
    market: CopyMarketService, ledger: CopyFollowerLedger, sources: CopyLiveSourceRepository, repository: CopyLiveWorkerRepository, scans: CopyFollowerScanRepository, stops: CopyLiveStopWorkerRepository, returns: CopyLiveReturnRepository, setups: CopyLiveSetupService, wallet: WalletNetworkHyperliquid,
    info: HyperliquidInfoClient, feed?: TradeFeedService): Promise<CopyLiveEngine | null> => {
    const live = config.value.copy.live;
    if (config.value.copy.mode !== 'testnet' || !live) return null;
    const logger = new Logger('CopyLiveEngine');
    // The process's one bucket for the wallet network (HyperliquidModule),
    // shared with the worker's setup pass and snapshot collector: no other
    // bucket on the same network (on testnet a separate host with its own
    // per-IP limit, so it neither starves nor is starved by the mainnet
    // watcher's budget).
    const { budget: testnetBudget, transport: testnetGlobal, config: testnetConfig } = wallet;
    const fit = assertLiveEvidenceCapacity({ capacity: testnetBudget.liveCapacity, maxStrategiesPerUser: await maxStrategiesPerUser(db),
      network: wallet.network, budgetPerMin: testnetConfig.value.hyperliquid.budgetPerMin });
    logger.log(`Order bucket (${wallet.network}): capacity ${fit.capacity}; the heaviest order evidence (${fit.users - 1} accounts + the leader) weighs ${fit.weight}`);
    // Every read and action takes its weight through reserveLive: a wait
    // that runs out is a HyperliquidBudgetWait (stored as live_budget_wait),
    // one heavier than the bucket fails at once (live_budget_over_capacity).
    // These readers bound the wait themselves (their clock): at most 5 s.
    const reserve = liveBudget(testnetBudget, { maxWaitMs: 5000 });
    const reference = new MainnetSourceReferenceReader(market);
    const options = { slippageBps: String(live.slippageBps), extraRiskBufferBps: EXTRA_RISK_BUFFER_BPS,
      restingOrderBuilderFeeCapTenthsBps: RESTING_BUILDER_FEE_CAP_TENTHS_BPS, maxSourceDeviationBps: String(live.maxSourceDeviationBps) };
    const scanner = new CopyFollowerReconciler(scans, ledger,
      new HyperliquidFollowerReceiptReader('testnet', weight => reserve(weight), testnetGlobal.fetchInfo,
        Date.now, weight => { if (weight > 0) testnetBudget.adjust(-weight); }));
    const closer = new TestnetReduceOnlyCloser(pool, db, uow, testnetConfig, testnetGlobal, testnetBudget, Math.max(100, live.slippageBps * 3));
    const stopper = new CopyLiveStopper({ repository: stops, closer, log: message => logger.warn(message), revokeDeadlineMs: live.revokeDeadlineMs,
      canceller: new StopCanceller(pool, db, testnetConfig, testnetGlobal, testnetBudget, stops, (account, key) => closer.reconcile(account, key)),
      // The stop ends once a sweep to the main wallet is credited: signed by
      // the worker under the owner's policy for accounts with the automatic
      // return, by the owner for every other account.
      swept: stop => returns.swept(stop.id),
      autoReturn: new CopyLiveAutoReturn(returns, new CopyFundingExchangeClient(testnetBudget, testnetGlobal),
        new PrivyPolicyMasterSigner({ appId: config.value.auth.appId, appSecret: config.value.auth.appSecret, workerQuorumId: config.value.copy.agent?.workerQuorumId,
          authorizationPrivateKey: config.value.copy.agent?.authorizationPrivateKey })) });
    const manual = new CopyLiveManualCloser(stops, closer, scanner, message => logger.warn(message));
    // Realtime mainnet signal (COPY_LIVE_FAST_SOURCE): the worker's mainnet
    // info client in the live lane, which acquires the worst case and gives
    // back what each answer didn't use.
    const fast = live.fastSource ? {
      source: new FastMainnetSource({
        fills: (leader, from) => info.userFillsSince(leader, from, 'live'),
        twapSlices: async (leader, from) => (await info.userTwapSliceFillsByTime(leader, from, undefined, 'live')).map(twapSliceToFill),
      }, live.fastSource.graceMs, Date.now, message => logger.warn(message)),
      leaders: live.fastSource.leaders,
      // No feed (or a socket down): the pass polls the fast leaders instead.
      feedUp: () => { const status = feed?.status(); return !!status && status.socketsTotal > 0 && status.disconnectedSince === null; },
    } : undefined;
    return new CopyLiveEngine({ setups, stopper: { tick: async () => { await stopper.tick(); await manual.tick(); } },
      repository, sources, uow, watched: new WatchedMainnetSource(db),
      testnetSource: new HyperliquidLiveSourceClient('testnet', weight => reserve(weight), testnetGlobal.fetchInfo,
        Date.now, weight => { if (weight > 0) testnetBudget.adjust(-weight); }),
      runtime: hooks => new TestnetLiveExecutionRuntime(pool, testnetConfig, testnetGlobal, testnetBudget, options, Date.now, { ...hooks, reference }),
      settler: new CopyLiveSettler(pool, testnetGlobal, testnetBudget, scanner),
      log: message => logger.warn(message),
      trace: message => logger.log(message),
      // The paper copier's cached leader capital: holds an open too small for
      // the exchange until the leader's next adds join it.
      leaderEquity: async leader => { const equity = await market.leaderEquity(leader); return equity.state === 'known' ? equity.value.toString() : null; },
      ...(fast ? { fast } : {}),
    }, DEFAULT_ENGINE_OPTIONS);
  },
};
