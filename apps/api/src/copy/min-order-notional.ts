import type { CopyRiskLimits } from "@trading-dashboard/shared/contracts";

import { Dec } from "../common/decimal/dec.js";
import { EXCHANGE_MIN_ORDER_NOTIONAL_USD } from "../config/constants/limits.js";

/** Hyperliquid's own minimum order value (USD), declared with the other constants; re-exported for its readers here. */
export { EXCHANGE_MIN_ORDER_NOTIONAL_USD };

/** THE smallest order a copy may send in every mode: policy `minOrderNotionalUsd`, never below the
 * exchange's 10. Fixed per-trade amounts should be ≥ 1.2 × this: IOC rounding can take
 * `max(10, limit) × 1.1` just under it. */
export function minOrderNotional(limits: Pick<CopyRiskLimits, "minOrderNotionalUsd">): Dec {
  return Dec.max(Dec.from(EXCHANGE_MIN_ORDER_NOTIONAL_USD), Dec.from(limits.minOrderNotionalUsd));
}
