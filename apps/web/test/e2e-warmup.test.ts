import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routes } from "../e2e/global-setup";

describe("the browser suite's route warm-up", () => {
  const found = routes(join(import.meta.dirname, "../src/app"));

  it("covers every page, with dynamic segments filled in", () => {
    expect(found).toContain("/en");
    expect(found).toContain("/en/portfolio");
    expect(found).toContain("/en/admin/copy/testnet");
    expect(found).toContain("/en/trader/0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f");
    expect(found).toContain("/en/coins/BTC");
    expect(found).toContain("/en/r/REFERRAL");
    expect(found).toContain("/en/admin/traders/jobs");
    expect(found).toContain("/en/dev");
    expect(found.filter((path) => /[\[\]]/.test(path))).toEqual([]);
    // Every page is under a locale.
    expect(found.filter((path) => !path.startsWith("/en"))).toEqual([]);
    expect(new Set(found).size).toBe(found.length);
  });
});
