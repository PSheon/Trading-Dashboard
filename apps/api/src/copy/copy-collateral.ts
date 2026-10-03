import type { CopyRiskLimits, CopyStrategySettings } from "@trading-dashboard/shared/contracts";
import { Dec } from "../common/decimal/dec.js";
import { MIDS_TTL_MS, type AssetMap, type Mids } from "./copy-market.service.js";
import type { PositionRow, StrategyRow } from "./copy.repository.js";
import { effectiveLeverage } from "./copy-risk.js";
import { strategyValue } from "./copy-planner.service.js";

/** Paper withdrawals never borrow against unrealized gains. Every open
 * position retains margin at the most conservative current leverage cap. */
export function freeCopyCollateral(strategy: Pick<StrategyRow, "cash">, settings: CopyStrategySettings,
  positions: PositionRow[], reservations: { margin: string }[], limits: CopyRiskLimits, mids: Mids | null, assets: AssetMap | null): Dec | null {
  if (positions.some((p) => !Dec.from(p.size).isZero)) {
    const stamp = mids?.at.getTime();
    const now = Date.now();
    if (stamp === undefined || !Number.isFinite(stamp) || stamp > now || now - stamp > MIDS_TTL_MS) return null;
  }
  const value = strategyValue(strategy, positions, mids);
  if (value.equity === null) return null;
  let margin = Dec.ZERO;
  for (const p of positions) {
    const size = Dec.from(p.size);
    if (size.isZero) continue;
    const asset = assets?.get(p.coin);
    const px = mids?.px.get(p.coin);
    if (!asset || !px?.isPositive) return null;
    margin = margin.add(size.abs().mul(px).div(effectiveLeverage(limits, settings, asset.maxLeverage)));
  }
  margin = margin.add(Dec.sum(reservations.map((r) => Dec.from(r.margin))));
  return Dec.max(Dec.ZERO, Dec.min(Dec.from(strategy.cash), value.equity.sub(margin))).floor(6);
}
