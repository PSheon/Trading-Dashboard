import { Logger, type FactoryProvider } from '@nestjs/common';
import type { Pool } from 'pg';
import { AppConfig } from '../../config/app-config.js';
import type { LiveCopyCaps } from '../../config/runtime-config.js';
import { effectiveMaxStrategiesPerUser } from '../copy-live-caps.js';
import { DATABASE_POOL, type DrizzleDb } from '../../db/drizzle.provider.js';
import { DRIZZLE_CLIENT } from '../../db/db.constants.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { desc } from 'drizzle-orm';
import { copyRiskPolicies } from '@trading-dashboard/shared/database';
import { copyRiskLimitsSchema } from '@trading-dashboard/shared/contracts';
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from '../../hyperliquid/wallet-network-hyperliquid.js';
import { liveBudget } from '../../hyperliquid/hyperliquid-budget-wait.js';
/** The settlement scanner's receipt reads outside a settlement pass (a manual close's): `live:receipt:`. */
const RECEIPT_OWNER = 'receipt';
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
import { LiveExecutionRuntime } from '../live/live-execution-runtime.js';
import { CopyLiveEngine, DEFAULT_ENGINE_OPTIONS } from './copy-live-engine.js';
import { liveStandbyNeed } from './live-standby-need.js';
import { HYPERLIQUID_SOURCE_REST_RESERVE } from '../../config/constants/hyperliquid.js';
import { CopyLiveSettler } from './copy-live-settler.js';
import { CopyLiveWorkerRepository } from './copy-live-worker.repository.js';
import { WatchedMainnetSource } from './watched-mainnet-source.js';
import { CopyLiveStopWorkerRepository } from './copy-live-stop-worker.repository.js';
import { CopyLiveManualCloser, CopyLiveStopper, StopCanceller } from './copy-live-stopper.js';
import { CopyLiveFlatCarry } from './copy-live-flat-carry.js';
import { DEFAULT_LIVE_STOP_TIMINGS } from '../../config/live-timings.js';
import { CopyLiveSystemStops } from '../copy-live-stop-system.js';
import { CopyLiveStopRepository } from '../copy-live-stop.repository.js';
import { CopyLiveMandateRepository } from '../copy-live-mandate.repository.js';
import { ReduceOnlyCloser } from './reduce-only-closer.js';
import { CopyLiveAutoReturn } from './copy-live-auto-return.js';
import { CopyFundingExchangeClient } from '../copy-funding-exchange.client.js';
import { WORKER_MASTER_SIGNER, type WorkerMasterSigner } from '../live/privy-policy-master-signer.js';
import { CopyLiveSetupService } from '../copy-live-setup.service.js';
import { HyperliquidInfoClient, twapSliceToFill } from '../../hyperliquid/hyperliquid-info.client.js';
import { TradeFeedService } from '../../watcher/trade-feed.service.js';
import { FastMainnetSource } from './fast-mainnet-source.js';
import { clockSkew } from '../live/clock-skew.js';
import { CopyFollowerSnapshotRepository } from '../copy-follower-snapshot.repository.js';

export const LIVE_ENGINE = Symbol('LIVE_ENGINE');
/** Risk inputs the runtime requires besides slippage and the price check. */
const EXTRA_RISK_BUFFER_BPS = '5', RESTING_BUILDER_FEE_CAP_TENTHS_BPS = 100;

/** Max copies per owner: the stricter of COPY_LIVE_MAX_STRATEGIES_PER_USER and the newest risk policy. */
export async function liveMaxStrategiesPerUser(db: DrizzleDb, caps: LiveCopyCaps): Promise<number> {
  const [row] = await db.select({ limits: copyRiskPolicies.limits }).from(copyRiskPolicies).orderBy(desc(copyRiskPolicies.version)).limit(1);
  const parsed = row ? copyRiskLimitsSchema.safeParse(row.limits) : undefined;
  return effectiveMaxStrategiesPerUser(caps, parsed?.success ? parsed.data : null);
}

/** Builds the engine; null unless COPY_TRADING_MODE is testnet or live. Refuses
 * startup if one order's evidence can't fit the order bucket (assertLiveEvidenceCapacity). */
export const liveEngineProvider: FactoryProvider<CopyLiveEngine | null> = {
  provide: LIVE_ENGINE,
  inject: [AppConfig, DATABASE_POOL, DRIZZLE_CLIENT, UnitOfWork, CopyMarketService, CopyFollowerLedger,
    CopyLiveSourceRepository, CopyLiveWorkerRepository, CopyFollowerScanRepository, CopyLiveStopWorkerRepository, CopyLiveReturnRepository, CopyLiveSetupService, WALLET_NETWORK_HL,
    HyperliquidInfoClient, WORKER_MASTER_SIGNER, CopyFollowerSnapshotRepository, { token: TradeFeedService, optional: true }],
  useFactory: async (config: AppConfig, pool: Pool, db: DrizzleDb, uow: UnitOfWork,
    market: CopyMarketService, ledger: CopyFollowerLedger, sources: CopyLiveSourceRepository, repository: CopyLiveWorkerRepository, scans: CopyFollowerScanRepository, stops: CopyLiveStopWorkerRepository, returns: CopyLiveReturnRepository, setups: CopyLiveSetupService, wallet: WalletNetworkHyperliquid,
    info: HyperliquidInfoClient, workerSigner: WorkerMasterSigner, snapshots: CopyFollowerSnapshotRepository, feed?: TradeFeedService): Promise<CopyLiveEngine | null> => {
    const live = config.value.copy.live;
    if (!live) return null;
    const network = live.network;
    if (network !== wallet.network) throw new Error(`The copy engine's network (${network}) is not the wallet network (${wallet.network})`);
    const logger = new Logger('CopyLiveEngine');
    // The process's single bucket for the wallet network (HyperliquidModule),
    // shared with setups and the snapshot collector.
    const { budget: walletBudget, transport: walletGlobal, config: walletConfig } = wallet;
    const fit = assertLiveEvidenceCapacity({ capacity: walletBudget.liveCapacity, maxStrategiesPerUser: await liveMaxStrategiesPerUser(db, live.caps),
      network: wallet.network, budgetPerMin: walletConfig.value.hyperliquid.budgetPerMin });
    logger.log(`Order bucket (${wallet.network}): capacity ${fit.capacity}; the heaviest order evidence (${fit.users - 1} accounts + the leader) weighs ${fit.weight}`);
    // reserveLive: a timed-out wait is HyperliquidBudgetWait; a weight over the
    // bucket fails at once (live_budget_over_capacity). Readers wait at most 5 s.
    const reserve = liveBudget(walletBudget, { maxWaitMs: 5000 });
    const reference = new MainnetSourceReferenceReader(market);
    const options = { slippageBps: String(live.slippageBps), extraRiskBufferBps: EXTRA_RISK_BUFFER_BPS,
      restingOrderBuilderFeeCapTenthsBps: RESTING_BUILDER_FEE_CAP_TENTHS_BPS, maxSourceDeviationBps: String(live.maxSourceDeviationBps) };
    const scanner = new CopyFollowerReconciler(scans, ledger,
      new HyperliquidFollowerReceiptReader(network, weight => reserve(weight), walletGlobal.fetchInfoOwned(RECEIPT_OWNER),
        Date.now, weight => { if (weight > 0) walletBudget.adjust(-weight); },
        { acquire: liveBudget(walletBudget, { maxWaitMs: Math.min(180_000, walletBudget.refillMs()) }), maxWaitMs: Math.min(180_000, walletBudget.refillMs()) + 2000 }));
    const closer = new ReduceOnlyCloser(network, pool, db, uow, walletConfig, walletGlobal, walletBudget, Math.max(100, live.slippageBps * 3));
    // Stop copies before their agent expires (closes need it); resume unfinished admin close-alls.
    const stopTimings = live.stop ?? DEFAULT_LIVE_STOP_TIMINGS;
    const systemStops = new CopyLiveSystemStops(db, uow, new CopyLiveStopRepository(new CopyLiveMandateRepository(db, config)), config);
    const stopper = new CopyLiveStopper({ repository: stops, closer, log: message => logger.warn(message), revokeDeadlineMs: live.revokeDeadlineMs, timings: stopTimings,
      systemStops: { agentExpiryMarginMs: stopTimings.agentExpiryMarginMs, stopExpiring: marginMs => systemStops.stopExpiring(marginMs), stopLiquidated: () => systemStops.stopLiquidated(),
        releaseClosedLiabilities: () => systemStops.releaseClosedLiabilities(), resumePendingCloseAll: () => systemStops.resumePendingCloseAll() },
      canceller: new StopCanceller(network, pool, db, walletConfig, walletGlobal, walletBudget, stops, (account, key) => closer.reconcile(account, key)),
      // The stop ends once a sweep to the main wallet is credited.
      swept: stop => returns.swept(stop.id),
      autoReturn: new CopyLiveAutoReturn(network, returns, new CopyFundingExchangeClient(walletBudget, walletGlobal), workerSigner) });
    const manual = new CopyLiveManualCloser(stops, closer, scanner, new CopyLiveFlatCarry(network, pool), message => logger.warn(message), Date.now, stopTimings.retry.closeAttempts);
    // Realtime mainnet signal (COPY_LIVE_FAST_SOURCE): the info client's live
    // priority on the local bucket; on the shared meter the `source` lane of
    // the leader (runSource), which yields to the follower's own orders.
    const fast = live.fastSource ? {
      source: new FastMainnetSource({
        fills: (leader, from) => walletGlobal.runSource(leader, () => info.userFillsSince(leader, from, 'live')),
        twapSlices: (leader, from) => walletGlobal.runSource(leader, async () => (await info.userTwapSliceFillsByTime(leader, from, undefined, 'live')).map(twapSliceToFill)),
      }, live.fastSource.graceMs, Date.now, message => logger.warn(message), () => clockSkew.aheadMs()),
      leaders: live.fastSource.leaders,
      // No feed (or a socket down): the pass polls the fast leaders instead.
      feedUp: () => { const status = feed?.status(); return !!status && status.socketsTotal > 0 && status.disconnectedSince === null; },
    } : undefined;
    return new CopyLiveEngine({ network, apiTerminalSettlement: network === 'testnet', setups, stopper: { tick: async () => { await stopper.tick(); await manual.tick(); } },
      // The heaviest order these copies can send now (its evidence and
      // boundary, what the read cache holds left out; at most the startup
      // bound fit.weight) and its settlement kept free on the shared meter
      // while copies run: neither waits for background (liveStandbyNeed).
      // With a fast source, the source lane's reserve is kept free of
      // background beside it (standbySource), so a kick's read finds room.
      standby: async mandates => {
        const need = liveStandbyNeed(mandates, network, fit.weight);
        if (need >= 1) await walletGlobal.standbyLive(need);
        if (need >= 1 && fast) await walletGlobal.standbySource(HYPERLIQUID_SOURCE_REST_RESERVE);
      },
      repository, sources, uow, watched: new WatchedMainnetSource(db, Date.now, message => logger.warn(message)),
      // Testnet leaders (testnet deployment only).
      testnetSource: new HyperliquidLiveSourceClient('testnet', weight => reserve(weight), walletGlobal.fetchInfoOwned('testnet-source'),
        Date.now, weight => { if (weight > 0) walletBudget.adjust(-weight); }),
      runtime: hooks => new LiveExecutionRuntime(network, pool, walletConfig, walletGlobal, walletBudget, options, Date.now, { ...hooks, reference }),
      settler: new CopyLiveSettler(network, pool, walletGlobal, walletBudget, scanner),
      settlementObservation: key => snapshots.saveSettlement(key),
      log: message => logger.warn(message), alert: message => logger.error(message),
      trace: message => logger.log(message),
      // Cached leader capital (paper copier's), for holding too-small opens.
      leaderEquity: async leader => { const equity = await market.leaderEquity(leader); return equity.state === 'known' ? equity.value.toString() : null; },
      ...(fast ? { fast } : {}),
    }, { ...DEFAULT_ENGINE_OPTIONS, testnetSourceIntervalMs: live.testnetSourceIntervalMs });
  },
};
