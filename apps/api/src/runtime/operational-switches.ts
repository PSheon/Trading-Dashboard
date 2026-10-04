import type { OperationalSwitches } from "@trading-dashboard/shared/contracts";

import type { RuntimeConfig } from "../config/runtime-config.js";

/**
 * What this process was started with, for the admin system page (review
 * finding 19): IS_WORKER, COPY_TRADING_MODE, HYPERLIQUID_NETWORK,
 * TELEGRAM_DRY_RUN, whether the S3 archive ingest is configured and its
 * S3_ARCHIVE_MAX_DAILY_USD, and the MAX_FAVORITES_PER_USER default. Values
 * only: no URL, bucket, key or token.
 */
export function operationalSwitches(config: RuntimeConfig): OperationalSwitches {
  return {
    isWorker: config.app.isWorker,
    copyTradingMode: config.copy.mode,
    hyperliquidNetwork: config.hyperliquid.wallet.network,
    telegramDryRun: config.telegram.dryRun,
    archiveEnabled: config.archive.enabled,
    archiveMaxDailyUsd: config.archive.maxDailyUsd,
    maxFavoritesPerUserDefault: config.limits.favoritesPerUser,
  };
}
