/** An ROI illustration, not a trade-by-trade backtest or an equity history. */
export function historicalSimulation(amount: number, roi: number | null, sparkline: readonly number[]) {
  if (roi === null || !Number.isFinite(roi)) return null;
  const profit = amount * roi;
  const total = amount + profit;
  const start = sparkline[0];
  const span = sparkline[sparkline.length - 1] - start;
  const usable = sparkline.length >= 3 && span !== 0 && sparkline.every(Number.isFinite);
  const series: Array<readonly [number, number]> = usable
    ? sparkline.map((value, index) => [index, amount + ((value - start) / span) * profit] as const)
    : [];
  return { total, profit, series };
}
