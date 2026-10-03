/**
 * Local logistic score fitted to a historical third-party sample. This is
 * an estimate, not a measured percentile of all active Hyperliquid traders.
 * The candidate pool is selected by PnL and cannot represent that population.
 * The archived calibration sample is regression evidence only, not an
 * independently verified holdout or proof of third-party algorithm parity.
 */

export interface CopyScoreInputs {
  /** Perp all-time ROI (PnL ÷ peak net deposits), 1 = 100%. */
  roi: number | null;
  /** Perp all-time PnL, USD. */
  pnl: number | null;
  /** Whole-account all-time Sharpe (CopyDog's `sharpe_raw`). */
  sharpe: number | null;
  /** Largest equity drawdown, 0–1 (`max_drawdown_raw`). */
  maxDrawdown: number | null;
  /** Interval returns behind the Sharpe (`return_sample_count`). */
  returnSamples: number;
  /** First to last point of the all-time series, days (`span_days`). */
  spanDays: number;
  accountValue: number | null;
}

/** Fitted weights (intercept, then one per feature, in `features` order). */
export const COPY_SCORE_WEIGHTS = [
  -4.5652, // intercept
  0.3178, // asinh(2 · roi)
  0.2141, // sharpe, clamped to [-4, 6]
  0.077, // signed log10(1 + |pnl|)
  0.4383, // min(span, 365) / 365: track record up to a year
  2.9636, // min(span, 90) / 90: CopyDog caps traders younger than ~90 days hard
  -1.112, // max drawdown
  0.2066, // ln(1 + return samples)
  0.2303, // log10(1 + account value)
] as const;

export const COPY_SCORE_MAX = 98;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const slog10 = (v: number) => Math.sign(v) * Math.log10(1 + Math.abs(v));

function features(x: CopyScoreInputs): number[] {
  const span = Math.max(0, x.spanDays);
  return [
    Math.asinh(2 * (x.roi ?? 0)),
    clamp(x.sharpe ?? 0, -4, 6),
    slog10(x.pnl ?? 0),
    Math.min(span, 365) / 365,
    Math.min(span, 90) / 90,
    clamp(x.maxDrawdown ?? 0, 0, 1),
    Math.log(1 + Math.max(0, x.returnSamples)),
    Math.log10(1 + Math.max(0, x.accountValue ?? 0)),
  ];
}

/**
 * 0–98, or null when there is no return series to judge (CopyDog scores
 * those on other data Orbie doesn't have; an unscored trader sorts last).
 */
export function copyScore(x: CopyScoreInputs): number | null {
  // No perp PnL at all: a holder, not a trader (CopyDog scores these ~20–32
  // from data it does not publish; Orbie leaves them unscored).
  if (!(x.returnSamples > 0) || x.sharpe === null || !x.pnl) return null;
  const f = features(x);
  const z = COPY_SCORE_WEIGHTS[0] + f.reduce((sum, v, i) => sum + v * COPY_SCORE_WEIGHTS[i + 1], 0);
  return Math.round(COPY_SCORE_MAX / (1 + Math.exp(-z)));
}
