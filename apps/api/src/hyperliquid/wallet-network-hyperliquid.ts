import { randomUUID } from 'node:crypto';
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
/** Share of a wallet-network bucket only real-money work may spend: an
 * order's evidence (589) and a setup's account mode (613) fit 80 % of an
 * 800 (testnet) or 900 (mainnet live) burst whatever background work does. */
export const LIVE_HEADROOM_SHARE = 0.8;
export interface WalletNetworkHyperliquid {
  /** The network the users' wallets and copy accounts live on. */
  readonly network: 'mainnet' | 'testnet';
  /** THE token bucket for this network in this process: every caller on it
   * (setup steps, wallet reads, the worker's copy engine, closer, settler,
   * stopper and snapshot collector) takes weight from this one, through
   * `reserveLive` (hyperliquid-budget-wait.ts). */
  readonly budget: RequestBudgeterService; readonly transport: HyperliquidGlobalTransport;
  /** Info reads (balances, ledgers) on the wallet network's budget and transport. */
  readonly info: HyperliquidInfoClient;
  /** The configuration `budget` was built from (its rate, burst and egress
   * key): what the network's runtime clients are constructed with. */
  readonly config: AppConfig;
  /** True when the budget is the wallet network's own (testnet, or mainnet
   * real-money copy), not the process's main one. */
  readonly dedicated: boolean;
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
    return { network, budget: new RequestBudgeterService(liveConfig), transport, info: mainInfo(), config: liveConfig, dedicated: true };
  }
  if (network !== 'testnet' || !hl.egressKey) return { network, budget, transport, info: mainInfo(), config, dedicated: false };
  const weightPerMin = config.value.copy.live?.weightPerMin ?? 300, egressKey = `${hl.egressKey}:testnet`;
  const testnetConfig = new AppConfig({ ...config.value, hyperliquid: { ...hl, egressKey, budgetPerMin: weightPerMin, burst: 1200 - weightPerMin, startupPaceSeconds: 0, liveHeadroomShare: LIVE_HEADROOM_SHARE } });
  const testnetBudget = new RequestBudgeterService(testnetConfig), testnetTransport = new HyperliquidGlobalTransport(quota, { egressKey, ownerId: randomUUID() });
  return { network, budget: testnetBudget, transport: testnetTransport, info: new HyperliquidInfoClient(testnetConfig, testnetBudget, jobs, testnetTransport), config: testnetConfig, dedicated: true };
}
