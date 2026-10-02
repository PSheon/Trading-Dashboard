import { describe, expect, it } from "vitest";

import { amountInput, normalizeAmount } from "../src/lib/amount-input";

/** What the field shows after each keystroke of `keys`. */
function typed(keys: string): string {
  let value = "";
  for (const key of keys) value = amountInput(value + key, value);
  return value;
}

describe("amount fields never change the magnitude of what was entered (review 61)", () => {
  it("a typed decimal comma is the decimal point: 12,5 is 12.5, not 125", () => {
    expect(typed("12,5")).toBe("12.5");
    expect(Number(typed("12,5"))).toBe(12.5);
    expect(typed("0,75")).toBe("0.75");
    expect(typed(",5")).toBe(".5");
    // The comma turns into the point as it is typed, so the field shows what will be sent.
    expect(typed("12,")).toBe("12.");
  });

  it("plain input is unchanged, and letters, spaces and currency signs are still dropped", () => {
    expect(typed("1250.50")).toBe("1250.50");
    expect(amountInput("$ 1 250.5 USDC", "")).toBe("1250.5");
    expect(amountInput("abc", "7")).toBe("");
  });

  it("a pasted number with both separators is read by which comes last", () => {
    expect(amountInput("1,250.50", "")).toBe("1250.50");
    expect(amountInput("1.250,50", "")).toBe("1250.50");
    expect(amountInput("12,345,678.9", "")).toBe("12345678.9");
    expect(amountInput("1,250,000", "")).toBe("1250000");
    expect(amountInput("12,5", "")).toBe("12.5");
    expect(amountInput("1234,567", "")).toBe("1234.567");
  });

  it("what can't be read without guessing is refused: the field keeps its value", () => {
    // 1,250 is 1250 in the site's own format and 1.25 with a decimal comma.
    expect(amountInput("1,250", "40")).toBe("40");
    expect(amountInput("12,500", "")).toBe("");
    expect(amountInput("1,25,0", "40")).toBe("40");
    expect(amountInput("1,2.5,0", "40")).toBe("40");
    expect(amountInput("12.5,3", "40")).toBe("40");
    expect(normalizeAmount("1,250")).toBeNull();
    expect(normalizeAmount("12a")).toBeNull();
  });

  it("no input of digits and one comma ever loses the comma", () => {
    for (const whole of ["1", "12", "125", "1250"]) {
      for (const fraction of ["", "5", "50", "500", "5000"]) {
        const out = amountInput(`${whole},${fraction}`, "kept");
        expect(out === "kept" || out === `${whole}.${fraction}`, `${whole},${fraction} → ${out}`).toBe(true);
      }
    }
  });
});
