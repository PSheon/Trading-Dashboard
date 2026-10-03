import { describe, expect, it } from "vitest";
import { copyRiskLimitsSchema } from "@trading-dashboard/shared/contracts";

describe("provider dex identity in risk policy", () => {
  it("can block the actual testnet i<3fl venue with exact provider spelling", () => {
    expect(copyRiskLimitsSchema.parse({ blockedCoins: ["i<3fl:TEST", "BTC"] }).blockedCoins).toEqual(["i<3fl:TEST", "BTC"]);
  });
  it("refuses spot identities, whitespace, separators and control bytes", () => {
    for (const name of ["@123", "USDC/USDT", "bad dex:TEST", "dex:TEST:MORE", "dex\\name:TEST", "dex\u0000:TEST"])
      expect(copyRiskLimitsSchema.safeParse({ blockedCoins: [name] }).success).toBe(false);
  });
});
