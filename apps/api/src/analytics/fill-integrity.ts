import type { HlUserFill } from "../hyperliquid/types.js";
import { executionOrder, isOutOfScopeSpotFill, signedSize, toScaled } from "../watcher/action-classifier.js";
import { applyFills, isPartial, type ApplyResult, type Trade } from "./trade-reconstruction.js";

/**
 * Correctness checks over a set of fills, independent of where they were
 * read (REST, the S3 archive, our own tables). They are the acceptance
 * gate for trusting a source: reconciliation compares two sources tid by
 * tid, and the invariants catch what a single source cannot hide — a
 * missing fill breaks the position chain, a double-counted one breaks the
 * PnL identity.
 */

/** Hyperliquid's documented REST retention ("only the 10000 most recent
 * fills are available"). An account holding fewer than this in a stream
 * cannot have been cut by it. */
export const UPSTREAM_RETENTION_FILLS = 10_000;

/** tids present more than once (after the caller's own deduplication this
 * must be empty; a self-trade is the one legitimate source of a repeat). */
export function duplicateTids(fills: HlUserFill[]): number[] {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const fill of fills) (seen.has(fill.tid) ? repeated : seen).add(fill.tid);
  return [...repeated];
}

export interface PositionBreak {
  coin: string;
  /** The fill whose `startPosition` does not continue the previous fill. */
  tid: number;
  time: number;
  /** Time of the coin's previous fill: the missing fills lie in `[after, time]`. */
  after: number;
  /** Position after the previous fill, and this fill's `startPosition`. */
  expected: string;
  actual: string;
}

/**
 * Perp fills whose `startPosition` differs from where the previous fill of
 * the coin left the position: at least one fill between them is missing
 * (or, at a source seam, the two sources disagree). Spot fills are out of
 * scope: transfers move spot balances without fills.
 *
 * Fills of one millisecond are judged together, since their order is not
 * recoverable from storage: the group continues the chain when one of its
 * fills starts at the running position, and it moves the position by its
 * net size. A fill missing inside a group therefore shows at the next one.
 */
export function positionBreaks(fills: HlUserFill[]): PositionBreak[] {
  const byCoin = new Map<string, HlUserFill[]>();
  for (const fill of fills) {
    if (isOutOfScopeSpotFill(fill) || fill.startPosition === undefined) continue;
    const list = byCoin.get(fill.coin) ?? [];
    list.push(fill);
    byCoin.set(fill.coin, list);
  }
  const breaks: PositionBreak[] = [];
  for (const [coin, list] of byCoin) {
    const ordered = executionOrder(list);
    let position: bigint | null = null;
    let previous = 0;
    for (let i = 0; i < ordered.length;) {
      let j = i;
      let net = 0n;
      while (j < ordered.length && ordered[j].time === ordered[i].time) net += signedSize(ordered[j++]);
      const group = ordered.slice(i, j);
      const starts = group.map((fill) => toScaled(fill.startPosition!));
      const at: bigint | null = position;
      const head: bigint | undefined = at === null ? starts[0] : starts.find((start) => start === at);
      if (head === undefined) {
        breaks.push({ coin, tid: group[0].tid, time: group[0].time, after: previous, expected: position!.toString(), actual: starts[0].toString() });
        position = starts[0] + net;
      } else {
        position = (position ?? head) + net;
      }
      previous = group[0].time;
      i = j;
    }
  }
  return breaks.sort((a, b) => a.time - b.time);
}

/** Σ `closedPnl` of the fills the reconstruction consumed, against Σ
 * realized PnL of every trade it produced (kept and dropped). The two are
 * the same additions grouped differently, so any difference beyond float
 * noise means a fill was counted twice or not at all. */
export function pnlIdentity(address: string, fills: HlUserFill[]): { fillsPnl: number; tradesPnl: number; difference: number; holds: boolean } {
  const unique = [...new Map(fills.map((fill) => [fill.tid, fill])).values()];
  const result = applyFills(address, new Map<string, Trade>(), unique, null);
  let fillsPnl = 0;
  for (const fill of unique) {
    if (isOutOfScopeSpotFill(fill) || fill.startPosition === undefined || signedSize(fill) === 0n) continue;
    fillsPnl += Number(fill.closedPnl) || 0;
  }
  const tradesPnl = [...result.touched, ...result.dropped].reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const difference = fillsPnl - tradesPnl;
  return { fillsPnl, tradesPnl, difference, holds: Math.abs(difference) <= 1e-6 * Math.max(1, Math.abs(fillsPnl)) };
}

/**
 * Whether figures built from `fills` may be presented as lifetime figures:
 * neither stream reaches upstream's retention size (so nothing older was
 * dropped before we read it), every position was opened inside the history
 * (no partial trade), no fill lacked `startPosition`, and the position
 * chain has no break. Anything else is "partial since the earliest fill".
 */
export function lifetimeComplete(fills: HlUserFill[], result: Pick<ApplyResult, "touched" | "skipped">): boolean {
  let regular = 0;
  let twap = 0;
  for (const fill of fills) {
    if (fill.twapId == null) regular += 1;
    else twap += 1;
  }
  if (regular >= UPSTREAM_RETENTION_FILLS || twap >= UPSTREAM_RETENTION_FILLS) return false;
  if (result.skipped > 0 || result.touched.some(isPartial)) return false;
  return positionBreaks(fills).length === 0;
}

export interface FillTotals {
  count: number;
  /** Σ px × sz. */
  volume: number;
  closedPnl: number;
  fees: number;
}

export interface FillMismatch {
  tid: number;
  field: string;
  left: string;
  right: string;
}

export interface Reconciliation {
  left: FillTotals;
  right: FillTotals;
  /** tids held by one side only. */
  onlyLeft: number[];
  onlyRight: number[];
  /** Same tid, different value in a compared field. */
  mismatches: FillMismatch[];
  /** Same tids and every compared field equal: the totals are then equal
   * by construction, not by tolerance. */
  exact: boolean;
}

const DECIMAL_FIELDS = ["px", "sz", "closedPnl", "fee", "startPosition"] as const;
const PLAIN_FIELDS = ["coin", "side", "time", "dir", "oid", "crossed", "feeToken"] as const;

/** Decimal strings compare by value ("1.0" = "1"); exact, not float. */
const canonical = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  const [whole, fraction = ""] = text.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const normal = `${whole.replace(/^(-?)0+(?=\d)/, "$1")}${trimmed ? `.${trimmed}` : ""}`;
  return normal === "-0" ? "0" : normal;
};

export function fillTotals(fills: HlUserFill[]): FillTotals {
  return fills.reduce<FillTotals>((totals, fill) => ({
    count: totals.count + 1,
    volume: totals.volume + Number(fill.px) * Number(fill.sz),
    closedPnl: totals.closedPnl + Number(fill.closedPnl),
    fees: totals.fees + Number(fill.fee),
  }), { count: 0, volume: 0, closedPnl: 0, fees: 0 });
}

/**
 * Compares two reads of the same account and window, tid by tid: which
 * fills each side lacks and every field that differs (price, size, side,
 * time, PnL, fee, start position, coin, direction, order id). Both inputs
 * are deduplicated by tid first.
 */
export function reconcileFills(left: HlUserFill[], right: HlUserFill[]): Reconciliation {
  const a = new Map(left.map((fill) => [fill.tid, fill]));
  const b = new Map(right.map((fill) => [fill.tid, fill]));
  const onlyLeft = [...a.keys()].filter((tid) => !b.has(tid));
  const onlyRight = [...b.keys()].filter((tid) => !a.has(tid));
  const mismatches: FillMismatch[] = [];
  for (const [tid, fill] of a) {
    const other = b.get(tid);
    if (!other) continue;
    const x = fill as unknown as Record<string, unknown>;
    const y = other as unknown as Record<string, unknown>;
    for (const field of [...DECIMAL_FIELDS, ...PLAIN_FIELDS]) {
      // A field one source omits entirely (older payloads) is not a conflict.
      if (x[field] === undefined || y[field] === undefined) continue;
      if (canonical(x[field]) !== canonical(y[field])) mismatches.push({ tid, field, left: String(x[field]), right: String(y[field]) });
    }
  }
  return {
    left: fillTotals([...a.values()]),
    right: fillTotals([...b.values()]),
    onlyLeft, onlyRight, mismatches,
    exact: onlyLeft.length === 0 && onlyRight.length === 0 && mismatches.length === 0,
  };
}

/** Every invariant of one fill set, for reports and tests. */
export function auditFills(address: string, fills: HlUserFill[]) {
  return {
    fills: fills.length,
    duplicateTids: duplicateTids(fills),
    positionBreaks: positionBreaks([...new Map(fills.map((fill) => [fill.tid, fill])).values()]),
    pnl: pnlIdentity(address, fills),
  };
}
