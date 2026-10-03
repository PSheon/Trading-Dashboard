/**
 * Candidate-pool percentile approximation of Copydog's published 30% ROI,
 * 30% Sharpe, 20% PnL and 20% track-record blend. Component normalization
 * (empirical midranks) and tie conventions are local inference. This never
 * claims Copydog's hidden formula or its full indexed population.
 */
export interface CopyScoreInputs {
  roi: number | null;
  pnl: number | null;
  sharpe: number | null;
  returnSamples: number | null;
  spanDays: number | null;
}

export const COPY_SCORE_MAX = 98;

/** Zero-based average ordinal ranks: tied values receive equal ranks. */
function midranks(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks: number[] = [];
  for (let first = 0; first < sorted.length;) {
    let end = first + 1;
    while (end < sorted.length && sorted[end].value === sorted[first].value) end++;
    const rank = (first + end - 1) / 2;
    for (let i = first; i < end; i++) ranks[sorted[i].index] = rank;
    first = end;
  }
  return ranks;
}

/**
 * Rank only complete finite inputs; actual zero ROI/PnL/Sharpe is valid.
 * Eligibility (activity, dust, local high-fill-rate exclusions) belongs to
 * the caller. Compute against the whole pool before presentation filters.
 * A singleton or entirely tied population uses the neutral midpoint 49.
 */
export function copyScores(traders: Array<{ address: string; inputs: CopyScoreInputs }>): Map<string, number> {
  const valid = traders.filter(({ inputs: x }) =>
    [x.roi, x.pnl, x.sharpe, x.spanDays, x.returnSamples].every(v => v !== null && Number.isFinite(v))
    && x.spanDays! > 0 && x.returnSamples! > 0);
  const components = (["roi", "sharpe", "pnl", "spanDays"] as const)
    .map(key => midranks(valid.map(t => t.inputs[key]!)));
  // Ranks share a denominator. Integer 3/3/2/2 weights preserve exact ties
  // and are equivalent to blending normalized component percentiles.
  const blended = valid.map((_, i) => 3 * components[0][i] + 3 * components[1][i]
    + 2 * components[2][i] + 2 * components[3][i]);
  const ranks = midranks(blended);
  return new Map(valid.map((t, i) => [t.address, valid.length === 1 ? 49
    : Math.round(COPY_SCORE_MAX * ranks[i] / (valid.length - 1))]));
}
