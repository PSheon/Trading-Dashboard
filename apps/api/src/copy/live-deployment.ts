import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { AppConfig } from '../config/app-config.js';
import type { LiveCopyCaps, LiveCopyConfig } from '../config/runtime-config.js';

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

/** What the order-time risk authority enforces besides the risk policy: the
 * deployment's network, its caps and its owner allowlist. */
export interface LiveDeploymentPolicy {
  readonly network: HyperliquidNetwork; readonly caps: LiveCopyCaps; readonly allowedPrivyUserIds?: ReadonlySet<string>;
}
let registered: LiveDeploymentPolicy | null = null;
/** Called once at boot with the validated config (RuntimeConfigModule): the
 * risk authority (postgres-live-risk-authority.ts) reads it for every order,
 * stop close and settlement plan, so a cap the env sets below the risk policy
 * holds at order time too, not only when a copy starts (security review). */
export function registerLiveDeployment(live: LiveCopyConfig | undefined): void {
  registered = live ? Object.freeze({ network: live.network, caps: Object.freeze({ ...live.caps }),
    ...(live.allowedPrivyUserIds ? { allowedPrivyUserIds: new Set(live.allowedPrivyUserIds) } : {}) }) : null;
}
export function liveDeploymentPolicy(): LiveDeploymentPolicy | null { return registered; }
