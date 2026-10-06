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
export interface AdjustmentRun { readonly legs: readonly PendingLeg[]; readonly lastOfCoin: boolean }
export interface AdjustmentPlan {
  /** Runs of two or more legs that become one order each; the lead (whose
   * order it is) is the run's newest leg, so its signal is the freshest. */
  readonly merges: readonly AdjustmentRun[];
  /** Legs held back this pass: an open too small for the exchange, waiting
   * for the next same-side legs of its coin. */
  readonly held: ReadonlySet<string>;
  /** Legs refused below_min_notional without an order: an open still too
   * small when a later run of its coin superseded it, or held to the bound. */
  readonly refused: ReadonlySet<string>;
}

/**
 * Same-coin leader legs of one copy that wait together become ONE follower
 * adjustment per run: consecutive legs of the same kind and side. A leader
 * who adds five times becomes one open of the summed size; reductions in a
 * row become one close of their combined fraction; a flip stays a close then
 * an open (each its own order: the open waits for the close). Runs keep
 * leader-time order, so an add, a reduce and an add stay three orders.
 *
 * Below the exchange minimum (`belowMinimum(run)`: the run's follower
 * notional can't reach it), an open run is held while it is its coin's
 * latest run, so the next adds join it and the whole goes as one order with
 * the newest add's fresh signal. A leg held longer than `accumulateMs` is
 * refused below_min_notional (it never reached the minimum within the
 * bound); so is a held run a later reduce or flip of its coin superseded.
 * A close is never held: it closes what the follower holds, and a leader's
 * full close is a full close (combined fraction 1).
 */
export function planAdjustments(legs: readonly PendingLeg[], now: number, accumulateMs: number,
  belowMinimum: (run: AdjustmentRun) => boolean): AdjustmentPlan {
  const byCoin = new Map<string, PendingLeg[]>();
  const merges: AdjustmentRun[] = [], held = new Set<string>(), refused = new Set<string>();
  for (const leg of legs) {
    // Held past the bound: never reached the minimum in time. (An open
    // that was not held is long expired by then: signals live minutes.)
    if (leg.leg === 'open' && now - leg.leaderTime >= accumulateMs) { refused.add(leg.id); continue; }
    byCoin.set(leg.coin, [...(byCoin.get(leg.coin) ?? []), leg]);
  }
  for (const coinLegs of byCoin.values()) {
    coinLegs.sort((a, b) => a.leaderTime - b.leaderTime || (a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0) || (a.leg === b.leg ? 0 : a.leg === 'close' ? -1 : 1));
    const runs: PendingLeg[][] = [];
    for (const leg of coinLegs) {
      const run = runs.at(-1), last = run?.at(-1);
      // A flip's legs are each their own order (its open waits for its close).
      const joins = run && last && last.leg === leg.leg && last.sign === leg.sign && run.length < MAX_MERGED_LEGS && !leg.flip && !last.flip &&
        leg.leaderTime - run[0]!.leaderTime < accumulateMs;
      if (joins) run.push(leg); else runs.push([leg]);
    }
    runs.forEach((run, index) => {
      const shaped: AdjustmentRun = { legs: run, lastOfCoin: index === runs.length - 1 };
      if (run[0]!.leg === 'open' && !run[0]!.flip && (run.every(leg => leg.belowMinimum) || belowMinimum(shaped))) {
        for (const leg of run) (shaped.lastOfCoin ? held : refused).add(leg.id);
        return;
      }
      if (run.length > 1) merges.push(shaped);
    });
  }
  return { merges, held, refused };
}

/** The follower notional an open run would have at most: its leader notional
 * scaled by the copy's budget over the leader's account value (ratio sizing
 * uses min(follower equity, budget), so this is an upper bound). */
export function openNotionalCeiling(run: AdjustmentRun, budgetUsd: string, leaderEquity: string): Dec | null {
  const equity = Dec.from(leaderEquity);
  if (!equity.isPositive) return null;
  return Dec.sum(run.legs.map(leg => Dec.from(leg.size).mul(leg.px))).mul(budgetUsd).div(equity);
}
