import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { walletBucketSchema } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { BackgroundJobs } from '../runtime/background-jobs.service.js';
import { HyperliquidGlobalTransport } from './hyperliquid-global-transport.js';
import { HyperliquidInfoClient } from './hyperliquid-info.client.js';
import { PostgresHyperliquidQuota } from './postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from './request-budgeter.service.js';

/** The Hyperliquid budget, transport and info client for reads and actions
 * on the users' wallet network. On testnet that is a separate host with its
 * own per-IP limit, so it gets its own token bucket and egress key: testnet
 * copy setup steps (account mode, agent approval, deposits), wallet balances
 * and ledgers, withdrawals and the worker's testnet copy engine must not wait
 * behind (or, on a 429, halve) the mainnet budget the pages and the watcher
 * use. One per process (HyperliquidModule): every testnet caller in a
 * process shares this one bucket, so a process holds at most one testnet
 * rate + burst against the shared per-IP meter. The meter
 * (postgres-hyperliquid-quota) stays the only cross-process limit: a charge
 * it refuses is a wait before any evidence clock starts (HyperliquidBudgetWait).
 * On mainnet without real-money copy it is the process's own mainnet budget,
 * transport and client; with it (COPY_TRADING_MODE=live) a bucket of its own
 * (COPY_LIVE_WEIGHT_PER_MIN) on the same transport. */
export const WALLET_NETWORK_HL = Symbol('WALLET_NETWORK_HL');
type WalletBucket = z.infer<typeof walletBucketSchema>;
/** Share of a wallet-network bucket kept for real-money work (its reserve,
 * refilled first, never spent by background work): an order's evidence
 * (589) and a setup's account mode (613) fit 80 % of an 800 (testnet) or
 * 900 (mainnet live) burst whatever receipts and snapshots do. */
export const LIVE_HEADROOM_SHARE = 0.8;
export interface WalletNetworkHyperliquid {
  /** The network the users' wallets and copy accounts live on. */
  readonly network: 'mainnet' | 'testnet';
  /** THE token bucket for this network in this process: every caller on it
   * (setup steps, wallet reads, the worker's copy engine, closer, settler,
   * stopper and snapshot collector) takes weight from this one, through
   * `reserveLive` (hyperliquid-budget-wait.ts). */
  readonly budget: RequestBudgeterService; readonly transport: HyperliquidGlobalTransport;
  /** THE token bucket of copy setups' steps on this network in this
   * process (account mode 715, agent approval 81, builder fee): on a
   * dedicated wallet network a bucket of its own, never `budget`. A setup's
   * steps drained the order bucket (mode 715 + agent 81 at 300 a minute, the
   * refill of 900 takes 3 min) right before its copy's first order: the
   * leader's source read was refused (`live_budget_wait`) and the order's
   * evidence (568) waited 67.6 s (gate 2026-10-13 11:13, 7th run). `budget`'s
   * burst is kept for orders, their source reads and observations. The
   * shared per-IP meter (postgres-hyperliquid-quota) is the one ceiling both
   * buckets have in common: it keeps the IP at 1200 a minute, setups behind
   * live orders. Not dedicated: `budget` itself, as before. */
  readonly setupBudget: RequestBudgeterService;
  /** Info reads (balances, ledgers) on the wallet network's budget and transport. */
  readonly info: HyperliquidInfoClient;
  /** The configuration `budget` was built from (its rate, burst and egress
   * key): what the network's runtime clients are constructed with. */
  readonly config: AppConfig;
  /** True when the budget is the wallet network's own (testnet, or mainnet
   * real-money copy), not the process's main one. */
  readonly dedicated: boolean;
}
/** One wallet-network bucket as the heartbeat and the admin overview show
 * it: rate, trailing-minute spend, tokens, reserve, queue and consumers. */
export function walletBucket(network: 'mainnet' | 'testnet', budget: Pick<RequestBudgeterService, 'introspect' | 'queued'>): WalletBucket {
  const w = budget.introspect();
  return { network, effectivePerMin: w.effectiveBudgetPerMin, weightLastMinute: w.weightLastMinute, tokensAvailable: Math.round(w.tokensAvailable),
    reserveTokens: Math.round(w.reserveTokens), queued: budget.queued(), consumers: w.consumers };
}
/** The setup bucket, when it is a bucket of its own (a dedicated wallet
 * network); undefined when setups share `budget`. */
export function walletSetupBucket(wallet: Pick<WalletNetworkHyperliquid, 'network' | 'budget' | 'setupBudget' | 'dedicated'>): WalletBucket | undefined {
  return wallet.dedicated && wallet.setupBudget !== wallet.budget ? walletBucket(wallet.network, wallet.setupBudget) : undefined;
}
export function walletNetworkHyperliquid(config: AppConfig, budget: RequestBudgeterService, transport: HyperliquidGlobalTransport, quota: PostgresHyperliquidQuota,
  info?: HyperliquidInfoClient, jobs: BackgroundJobs = new BackgroundJobs()): WalletNetworkHyperliquid {
  const hl = config.value.hyperliquid, network = hl.wallet.network;
  const mainInfo = () => info ?? new HyperliquidInfoClient(config, budget, jobs, transport);
  const live = config.value.copy.live;
  if (network === 'mainnet' && live && hl.egressKey) {
    // Real-money copy on mainnet: setup steps (account mode 613, agent
    // approval), orders, returns and stops get their own bucket on the same
    // host, IP and egress key (the shared meter still counts both). On the
    // process's main bucket the worker's snapshots, analytics and sweeps kept
    // it near empty and a copy setup waited on its account-mode step for
    // hours (Stage, 2026-10-11). Wallet page reads stay on the main budget.
    const weightPerMin = live.weightPerMin;
    const liveConfig = new AppConfig({ ...config.value, hyperliquid: { ...hl, budgetPerMin: weightPerMin, burst: 1200 - weightPerMin, startupPaceSeconds: 0, liveHeadroomShare: LIVE_HEADROOM_SHARE } });
    return { network, budget: new RequestBudgeterService(liveConfig), setupBudget: new RequestBudgeterService(liveConfig), transport, info: mainInfo(), config: liveConfig, dedicated: true };
  }
  if (network !== 'testnet' || !hl.egressKey) return { network, budget, setupBudget: budget, transport, info: mainInfo(), config, dedicated: false };
  const weightPerMin = config.value.copy.live?.weightPerMin ?? 300, egressKey = `${hl.egressKey}:testnet`;
  const testnetConfig = new AppConfig({ ...config.value, hyperliquid: { ...hl, egressKey, budgetPerMin: weightPerMin, burst: 1200 - weightPerMin, startupPaceSeconds: 0, liveHeadroomShare: LIVE_HEADROOM_SHARE } });
  const testnetBudget = new RequestBudgeterService(testnetConfig), testnetTransport = new HyperliquidGlobalTransport(quota, { egressKey, ownerId: randomUUID() });
  return { network, budget: testnetBudget, setupBudget: new RequestBudgeterService(testnetConfig), transport: testnetTransport,
    info: new HyperliquidInfoClient(testnetConfig, testnetBudget, jobs, testnetTransport), config: testnetConfig, dedicated: true };
}
