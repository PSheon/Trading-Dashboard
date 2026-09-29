import { describe, expect, it } from "vitest";
import { missingSparklines } from "../src/lib/queries";

describe("sparkline polling", () => {
  it("asks again only for addresses the api left out", () => {
    const a = `0x${"a1".repeat(20)}`;
    const b = `0x${"b2".repeat(20)}`;
    expect(missingSparklines([a, b], undefined)).toEqual([]);
    expect(missingSparklines([a, b], { [a]: [[1, 2]] })).toEqual([b]);
    // A failed fetch comes back as [] and is not retried.
    expect(missingSparklines([a, b], { [a]: [], [b]: [[1, 2]] })).toEqual([]);
  });
});
