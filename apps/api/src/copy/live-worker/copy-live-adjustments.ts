import { Dec } from '../../common/decimal/dec.js';
import { MAX_MERGED_LEGS } from '../live/copy-live-source-planner.js';

/** A pending leader leg of one copy, with what merging needs from its fill. */
export interface PendingLeg {
  readonly id: string;
  readonly sourceFillId: string;
  readonly coin: string;
  readonly leg: 'open' | 'close';
  readonly sign: 1 | -1;
  /** Leader size of this leg and the fill price (leader notional = size × px). */
  readonly size: string;
  readonly px: string;
  readonly leaderTime: number;
  readonly tid: bigint;
  /** The fill flips the position (a close and an open leg). */
  readonly flip: boolean;
  /** A previous attempt of exactly these legs was below the minimum order. */
  readonly belowMinimum: boolean;
}
interface AdjustmentRun { readonly legs: readonly PendingLeg[]; readonly lastOfCoin: boolean }
interface AdjustmentPlan {
  /** Runs of 2+ legs, one order each, led by the newest (freshest) leg. */
  readonly merges: readonly AdjustmentRun[];
  /** Opens too small for the exchange, held for the next same-side legs. */
  readonly held: ReadonlySet<string>;
  /** Too-small opens superseded by a later run of the coin (below_min_notional). */
  readonly refused: ReadonlySet<string>;
  /** Open legs that aged out while merging or held (merged_signal_expired), never sent. */
  readonly expired: ReadonlySet<string>;
}

/**
 * Consecutive same-coin, same-kind, same-side legs become one follower order
 * per run, in leader-time order (add, reduce, add stays three orders). A flip
 * stays a close then an open.
 *
 * An open run below the minimum (`belowMinimum`) is held while it is the coin's
 * latest run, else refused. Merged/held open legs at `windowMs` or older (signal
 * age less planning margin) are dropped. A close is never held or dropped.
 */
export function planAdjustments(legs: readonly PendingLeg[], now: number, windowMs: number,
  belowMinimum: (run: AdjustmentRun) => boolean): AdjustmentPlan {
  const byCoin = new Map<string, PendingLeg[]>();
  const merges: AdjustmentRun[] = [], held = new Set<string>(), refused = new Set<string>(), expired = new Set<string>();
  for (const leg of legs) byCoin.set(leg.coin, [...(byCoin.get(leg.coin) ?? []), leg]);
  for (const coinLegs of byCoin.values()) {
    coinLegs.sort((a, b) => a.leaderTime - b.leaderTime || (a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0) || (a.leg === b.leg ? 0 : a.leg === 'close' ? -1 : 1));
    const runs: PendingLeg[][] = [];
    for (const leg of coinLegs) {
      const run = runs.at(-1), last = run?.at(-1);
      // A flip's legs are each their own order (its open waits for its close).
      const joins = run && last && last.leg === leg.leg && last.sign === leg.sign && run.length < MAX_MERGED_LEGS && !leg.flip && !last.flip;
      if (joins) run.push(leg); else runs.push([leg]);
    }
    runs.forEach((all, index) => {
      const lastOfCoin = index === runs.length - 1, isOpen = all[0]!.leg === 'open' && !all[0]!.flip;
      const below = (legs: readonly PendingLeg[]) => isOpen && legs.length > 0 && (legs.every(leg => leg.belowMinimum) || belowMinimum({ legs, lastOfCoin }));
      // Drop open legs that would wait or merge past their signal age; a lone
      // leg keeps the signal_expired path. Closes never age (CP-EXE-14-02).
      const mergesOrWaits = all.length > 1 || below(all);
      const run = mergesOrWaits && all[0]!.leg === 'open' ? all.filter(leg => now - leg.leaderTime < windowMs) : all;
      if (mergesOrWaits) for (const leg of all) if (!run.includes(leg)) expired.add(leg.id);
      if (!run.length) return;
      if (below(run)) { for (const leg of run) (lastOfCoin ? held : refused).add(leg.id); return; }
      if (run.length > 1) merges.push({ legs: run, lastOfCoin });
    });
  }
  return { merges, held, refused, expired };
}

/** Upper bound on an open run's follower notional: leader notional × budget /
 * leader equity (ratio sizing uses min(follower equity, budget)). */
export function openNotionalCeiling(run: AdjustmentRun, budgetUsd: string, leaderEquity: string): Dec | null {
  const equity = Dec.from(leaderEquity);
  if (!equity.isPositive) return null;
  return Dec.sum(run.legs.map(leg => Dec.from(leg.size).mul(leg.px))).mul(budgetUsd).div(equity);
}
