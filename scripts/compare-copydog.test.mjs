import { test } from "node:test";
import assert from "node:assert/strict";
import { comparison, scoreComparison, buildReport } from "./compare-copydog.mjs";

test("missing values do not become zero or numeric matches", () => {
  assert.equal(comparison("roi", null, 0, 1e-6).status, "unavailable");
  assert.equal(comparison("roi", 0, undefined, 1e-6).status, "unavailable");
  assert.equal(comparison("roi", 0, 0, 1e-6).withinReferenceResolution, true);
  assert.equal(comparison("roi", 1, 0, 1e-6).relativeDifference, null);
});
test("unscored samples remain separate from the error distribution", () => {
  const result = scoreComparison([[30, 0, 0, 0, 0, 0, 0, 0]]);
  assert.equal(result.total, 1);
  assert.equal(result.scored, 0);
  assert.equal(result.medianAbsoluteError, null);
  assert.equal(result.threshold80Agreement, null);
  assert.equal(result.unscored.length, 1);
});
test("score replay ranks only the declared saved sample, rather than fitting absolute third-party scores", () => {
  const result = scoreComparison([
    [49, 4, 2, 1, 0, 10, 3, 1000], [98, 3, 1, 4, 0, 10, 2, 1000],
    [49, 2, 4, 3, 0, 10, 1, 1000], [0, 1, 3, 2, 0, 10, 4, 1000],
  ]);
  assert.equal(result.medianAbsoluteError, 0);
  assert.equal(result.maxAbsoluteError, 0);
  assert.equal(result.rankingScope, "saved_sample");
  assert.equal(result.scoreEligibleCount, 4);
});
test("reports temporal gaps even where numeric results match", () => {
  const result = buildReport();
  assert.equal(result.frozenPortfolio.verdict, "not_time_aligned");
  assert.ok(result.frozenPortfolio.timeDifferenceSeconds > 85);
  assert.equal(result.livePortfolio.verdict, "not_time_aligned");
  // This frozen day's ROI has no valid denominator; drawdown is a numeric match.
  assert.equal(result.frozenPortfolio.rows.find(r => r.window === "day").metrics[0].status, "unavailable");
  assert.equal(result.frozenPortfolio.rows.find(r => r.window === "day").metrics[2].withinReferenceResolution, true);
  assert.equal(result.frozenPortfolio.rows.find(r => r.window === "day").metrics[1].withinReferenceResolution, false);
  assert.equal(result.scoreCalibrationSample.total, 549);
  // A finite zero-PnL record remains valid in the percentile model.
  assert.equal(result.scoreCalibrationSample.scored, 549);
  assert.equal(result.inputs.length, 3);
  assert.ok(result.inputs.every(i => /^[a-f0-9]{64}$/.test(i.sha256)));
  assert.equal(result.liveScore.status, "unavailable");
  assert.equal(result.liveScore.actual, null);
});
