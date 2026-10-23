import { ConflictException } from '@nestjs/common';
import type { CopyRiskLimits, CopyStrategySettings } from '@trading-dashboard/shared/contracts';
import type { LiveCopyCaps } from '../config/runtime-config.js';
import { Dec } from '../common/decimal/dec.js';

/** The deployment's caps (COPY_LIVE_*) and the newest risk policy, the stricter of each wins; without
 * caps the policy is unchanged. */
export function effectiveMaxStrategiesPerUser(caps: LiveCopyCaps | undefined, limits: Pick<CopyRiskLimits, 'maxStrategiesPerUser'> | null): number {
  if (!caps) return limits?.maxStrategiesPerUser ?? 1;
  return limits ? Math.min(caps.maxStrategiesPerUser, limits.maxStrategiesPerUser) : caps.maxStrategiesPerUser;
}

/** The policy's limits with the deployment's caps applied. A policy minimum above the capped maximum
 * gives way to it, or no budget could ever pass. */
export function effectiveLiveLimits<T extends Pick<CopyRiskLimits, 'maxStrategiesPerUser' | 'maxAllocationUsd' | 'minAllocationUsd' | 'maxLeverage'>>(caps: LiveCopyCaps | undefined, limits: T): T {
  if (!caps) return limits;
  const maxAllocationUsd = caps.maxAllocationUsd === undefined ? limits.maxAllocationUsd : Math.min(caps.maxAllocationUsd, limits.maxAllocationUsd);
  return {
    ...limits,
    maxStrategiesPerUser: Math.min(caps.maxStrategiesPerUser, limits.maxStrategiesPerUser),
    maxAllocationUsd, minAllocationUsd: Math.min(limits.minAllocationUsd, maxAllocationUsd),
    maxLeverage: caps.maxLeverage === undefined ? limits.maxLeverage : Math.min(caps.maxLeverage, limits.maxLeverage),
  };
}

/**
 * Settings an actual copy may use on this deployment. The sizing rule follows
 * the mode `liveCaps` (runtime-config.ts) built the caps for, one or the other,
 * never both: a live deployment carries `ratioOnly` (decision D6: real-money
 * copies size by ratio to the trader, the fixed bounds are ignored there), a
 * testnet deployment may carry `fixedPerTradeUsd` (COPY_LIVE_FIXED_PER_TRADE_MIN_USD
 * / _MAX_USD: only fixed sizing, the per-trade amount inside them; 12–15 USDC
 * by default, above the exchange's 10 USDC minimum with rounding room). Were
 * both ever set, `ratioOnly` decides. A leverage no higher than the cap on
 * either. Refusals the UI names (wire-contracts `copyErrorCodes`).
 */
export function assertLiveSettings(caps: LiveCopyCaps | undefined, settings: Pick<CopyStrategySettings, 'sizingMode' | 'perTradeUsd' | 'maxLeverage'>): void {
  if (!caps) return;
  const fixed = caps.fixedPerTradeUsd;
  if (caps.ratioOnly) {
    if (settings.sizingMode !== 'ratio') throw new ConflictException({ statusCode: 409, code: 'live_ratio_sizing_required', message: 'Real-fund copies size by ratio to the trader' });
  } else if (fixed) {
    if (settings.sizingMode !== 'fixed') {
      throw new ConflictException({ statusCode: 409, code: 'live_fixed_sizing_required', message: 'These copies use a fixed amount per trade', min: fixed.min, max: fixed.max });
    } else {
      const amount = settings.perTradeUsd;
      if (amount === null || Dec.from(String(amount)).lt(String(fixed.min)) || Dec.from(String(amount)).gt(String(fixed.max))) {
        throw new ConflictException({ statusCode: 409, code: 'live_per_trade_out_of_range', message: `The amount per trade must be between ${fixed.min} and ${fixed.max} USDC`, min: fixed.min, max: fixed.max });
      }
    }
  }
  if (caps.maxLeverage !== undefined && settings.maxLeverage !== null && settings.maxLeverage > caps.maxLeverage) {
    throw new ConflictException({ statusCode: 409, code: 'leverage_above_limit', message: 'Leverage above the platform limit', limit: caps.maxLeverage });
  }
}
