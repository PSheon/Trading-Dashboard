import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { AppConfig } from '../config/app-config.js';

/**
 * One network per deployment (workstream ②, 2026-10-07): HYPERLIQUID_NETWORK
 * is the only source of the network actual copies execute on. Every worker
 * and api path acts only on rows of this network; rows of the other network
 * (e.g. testnet copies left in a database that moved to mainnet) stay
 * readable history and nothing on them is signed or sent.
 */
export function deploymentNetwork(config: AppConfig): HyperliquidNetwork {
  return config.value.hyperliquid.wallet.network;
}

/** Actual copies execute on this deployment (COPY_TRADING_MODE testnet or
 * live, whose prerequisites startup checked). */
export function liveExecutionEnabled(config: AppConfig): boolean {
  return Boolean(config.value.copy.live);
}
