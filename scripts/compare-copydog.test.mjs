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
test("reports temporal gaps even where numeric results match", () => {
  const result = buildReport();
  assert.equal(result.frozenPortfolio.verdict, "not_time_aligned");
  assert.ok(result.frozenPortfolio.timeDifferenceSeconds > 85);
  assert.equal(result.livePortfolio.verdict, "not_time_aligned");
  assert.equal(result.frozenPortfolio.rows.find(r => r.window === "day").metrics[0].withinReferenceResolution, true);
  assert.equal(result.frozenPortfolio.rows.find(r => r.window === "day").metrics[1].withinReferenceResolution, false);
  assert.equal(result.scoreCalibrationSample.total, 549);
  assert.equal(result.scoreCalibrationSample.scored, 548);
  assert.equal(result.inputs.length, 3);
  assert.ok(result.inputs.every(i => /^[a-f0-9]{64}$/.test(i.sha256)));
});
