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
  /** Runs of two or more legs that become one order each (lead = first leg). */
  readonly merges: readonly AdjustmentRun[];
  /** Legs held back this pass: an open too small for the exchange, waiting
   * for the next same-side legs of its coin. */
  readonly held: ReadonlySet<string>;
}

/**
 * Same-coin leader legs of one copy that wait together become ONE follower
 * adjustment per run: consecutive legs of the same kind and side. A leader
 * who adds five times becomes one open of the summed size; reductions in a
 * row become one close of their combined fraction; a flip stays a close then
 * an open (its close is always alone, its open may lead the adds after it).
 * Runs keep leader-time order, so an add, a reduce and an add stay three
 * orders, in that order.
 *
 * An open run whose follower size would be below the exchange minimum
 * (`holdOpen`) is held while it is the coin's latest run, so the next adds
 * join it, at most until `holdBound` after its first leg; then it goes (and
 * a run still too small is refused below_min_notional). A close is never
 * held: it closes what the follower holds, and a leader's full close is a
 * full close (combined fraction 1).
 */
export function planAdjustments(legs: readonly PendingLeg[], now: number, holdBoundMs: number,
  holdOpen: (run: AdjustmentRun) => boolean): AdjustmentPlan {
  const byCoin = new Map<string, PendingLeg[]>();
  for (const leg of legs) byCoin.set(leg.coin, [...(byCoin.get(leg.coin) ?? []), leg]);
  const merges: AdjustmentRun[] = [], held = new Set<string>();
  for (const coinLegs of byCoin.values()) {
    coinLegs.sort((a, b) => a.leaderTime - b.leaderTime || (a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0) || (a.leg === b.leg ? 0 : a.leg === 'close' ? -1 : 1));
    const runs: PendingLeg[][] = [];
    for (const leg of coinLegs) {
      const run = runs.at(-1), last = run?.at(-1);
      const joins = run && last && last.leg === leg.leg && last.sign === leg.sign && run.length < MAX_MERGED_LEGS &&
        // A flip's close is its own order; a flip's open only leads a run.
        !(leg.flip && leg.leg === 'close') && !(last.flip && last.leg === 'close') && !(leg.flip && leg.leg === 'open');
      if (joins) run.push(leg); else runs.push([leg]);
    }
    runs.forEach((run, index) => {
      const shaped: AdjustmentRun = { legs: run, lastOfCoin: index === runs.length - 1 };
      const oldest = Math.min(...run.map(leg => leg.leaderTime));
      if (run[0]!.leg === 'open' && shaped.lastOfCoin && now - oldest < holdBoundMs &&
        (run.every(leg => leg.belowMinimum) || holdOpen(shaped))) {
        for (const leg of run) held.add(leg.id);
        return;
      }
      if (run.length > 1) merges.push(shaped);
    });
  }
  return { merges, held };
}

/** The follower notional an open run would have at most: its leader notional
 * scaled by the copy's budget over the leader's account value (ratio sizing
 * uses min(follower equity, budget), so this is an upper bound). */
export function openNotionalCeiling(run: AdjustmentRun, budgetUsd: string, leaderEquity: string): Dec | null {
  const equity = Dec.from(leaderEquity);
  if (!equity.isPositive) return null;
  return Dec.sum(run.legs.map(leg => Dec.from(leg.size).mul(leg.px))).mul(budgetUsd).div(equity);
}
