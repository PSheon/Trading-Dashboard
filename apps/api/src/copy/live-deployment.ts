import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { AppConfig } from '../config/app-config.js';
import type { LiveCopyCaps, LiveCopyConfig } from '../config/runtime-config.js';

/** One network per deployment (2026-10-07): HYPERLIQUID_NETWORK. Rows of another network are
 * read-only history; nothing on them is signed or sent. */
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
interface LiveDeploymentPolicy {
  readonly network: HyperliquidNetwork; readonly caps: LiveCopyCaps; readonly allowedPrivyUserIds?: ReadonlySet<string>;
}
let registered: LiveDeploymentPolicy | null = null;
/** Registered at boot; the risk authority reads it on every order, stop close and settlement plan,
 * so env caps hold at order time too (security review). */
export function registerLiveDeployment(live: LiveCopyConfig | undefined): void {
  registered = live ? Object.freeze({ network: live.network, caps: Object.freeze({ ...live.caps }),
    ...(live.allowedPrivyUserIds ? { allowedPrivyUserIds: new Set(live.allowedPrivyUserIds) } : {}) }) : null;
}
export function liveDeploymentPolicy(): LiveDeploymentPolicy | null { return registered; }
