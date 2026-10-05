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
 * On mainnet it is the process's own mainnet budget, transport and client. */
export const WALLET_NETWORK_HL = Symbol('WALLET_NETWORK_HL');
export interface WalletNetworkHyperliquid {
  readonly budget: RequestBudgeterService; readonly transport: HyperliquidGlobalTransport;
  /** Info reads (balances, ledgers) on the wallet network's budget and transport. */
  readonly info: HyperliquidInfoClient;
  /** True when these are the testnet's own (not the mainnet ones). */
  readonly dedicated: boolean;
}
export function walletNetworkHyperliquid(config: AppConfig, budget: RequestBudgeterService, transport: HyperliquidGlobalTransport, quota: PostgresHyperliquidQuota,
  info?: HyperliquidInfoClient, jobs: BackgroundJobs = new BackgroundJobs()): WalletNetworkHyperliquid {
  const hl = config.value.hyperliquid;
  if (hl.wallet.network !== 'testnet' || !hl.egressKey) return { budget, transport, info: info ?? new HyperliquidInfoClient(config, budget, jobs, transport), dedicated: false };
  const weightPerMin = config.value.copy.live?.weightPerMin ?? 300, egressKey = `${hl.egressKey}:testnet`;
  const testnetConfig = new AppConfig({ ...config.value, hyperliquid: { ...hl, egressKey, budgetPerMin: weightPerMin, burst: 1200 - weightPerMin, startupPaceSeconds: 0 } });
  const testnetBudget = new RequestBudgeterService(testnetConfig), testnetTransport = new HyperliquidGlobalTransport(quota, { egressKey, ownerId: randomUUID() });
  return { budget: testnetBudget, transport: testnetTransport, info: new HyperliquidInfoClient(testnetConfig, testnetBudget, jobs, testnetTransport), dedicated: true };
}
