import type { CopyRiskLimits } from "@trading-dashboard/shared/contracts";

import { Dec } from "../common/decimal/dec.js";

/** Hyperliquid's own minimum order value (USD): an order below it is refused by the exchange. */
export const EXCHANGE_MIN_ORDER_NOTIONAL_USD = 10;

/**
 * THE smallest order a copy may send, paper and live alike: the policy's
 * `minOrderNotionalUsd`, never below the exchange's 10. Used by the live
 * engine (holding a too-small open), the live risk gate, the live
 * preparation (a merged open) and the paper risk and planner, so a copy
 * refuses the same orders in every mode. A fixed amount per trade should be
 * at least 1.2 × this (12–15 USDC): IOC rounding can take a size of
 * `max(10, limit) × 1.1` just under it.
 */
export function minOrderNotional(limits: Pick<CopyRiskLimits, "minOrderNotionalUsd">): Dec {
  return Dec.max(Dec.from(EXCHANGE_MIN_ORDER_NOTIONAL_USD), Dec.from(limits.minOrderNotionalUsd));
}
