import { ConflictException } from '@nestjs/common';
import type { CopyRiskLimits, CopyStrategySettings } from '@trading-dashboard/shared/contracts';
import type { LiveCopyCaps } from '../config/runtime-config.js';
import { Dec } from '../common/decimal/dec.js';

/**
 * The deployment's caps on actual copies (COPY_LIVE_*), applied as the
 * stricter of each cap and the newest risk policy: a database policy that is
 * looser than the deployment (Stage's v1: 10 copies, 100,000 USDC) can't
 * widen it, and a stricter policy still wins. Without caps (no actual
 * execution on this deployment) the policy is unchanged.
 */
export function effectiveMaxStrategiesPerUser(caps: LiveCopyCaps | undefined, limits: Pick<CopyRiskLimits, 'maxStrategiesPerUser'> | null): number {
  if (!caps) return limits?.maxStrategiesPerUser ?? 1;
  return limits ? Math.min(caps.maxStrategiesPerUser, limits.maxStrategiesPerUser) : caps.maxStrategiesPerUser;
}

/** The policy's limits with the deployment's caps applied. A policy minimum
 * allocation above the deployment's maximum (Stage's v1: 100 against a 50
 * cap) gives way to it, or no budget could ever pass. */
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
 * Settings an actual copy may use on this deployment: with fixed bounds
 * (COPY_LIVE_FIXED_PER_TRADE_MIN_USD / _MAX_USD; always on a live deployment)
 * only fixed sizing, with the per-trade amount inside them (12–15 USDC by
 * default: above the exchange's 10 USDC minimum with rounding room); and a
 * leverage no higher than the cap. Refusals the UI names
 * (wire-contracts `copyErrorCodes`).
 */
export function assertLiveSettings(caps: LiveCopyCaps | undefined, settings: Pick<CopyStrategySettings, 'sizingMode' | 'perTradeUsd' | 'maxLeverage'>): void {
  if (!caps) return;
  const fixed = caps.fixedPerTradeUsd;
  if (fixed) {
    if (settings.sizingMode !== 'fixed') {
      throw new ConflictException({ statusCode: 409, code: 'live_fixed_sizing_required', message: 'Real-fund copies use a fixed amount per trade', min: fixed.min, max: fixed.max });
    }
    const amount = settings.perTradeUsd;
    if (amount === null || Dec.from(String(amount)).lt(String(fixed.min)) || Dec.from(String(amount)).gt(String(fixed.max))) {
      throw new ConflictException({ statusCode: 409, code: 'live_per_trade_out_of_range', message: `The amount per trade must be between ${fixed.min} and ${fixed.max} USDC`, min: fixed.min, max: fixed.max });
    }
  }
  if (caps.maxLeverage !== undefined && settings.maxLeverage !== null && settings.maxLeverage > caps.maxLeverage) {
    throw new ConflictException({ statusCode: 409, code: 'leverage_above_limit', message: 'Leverage above the platform limit', limit: caps.maxLeverage });
  }
}
