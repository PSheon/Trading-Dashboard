import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routes } from "../e2e/global-setup";

describe("the browser suite's route warm-up", () => {
  const found = routes(join(import.meta.dirname, "../src/app"));

  it("covers every page, with dynamic segments filled in", () => {
    expect(found).toContain("/");
    expect(found).toContain("/portfolio");
    expect(found).toContain("/admin/copy/users");
    expect(found).toContain("/trader/0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f");
    expect(found).toContain("/coins/BTC");
    expect(found).toContain("/r/REFERRAL");
    expect(found).toContain("/admin/copy/strategies/2");
    expect(found).toContain("/dev");
    expect(found.filter((path) => /[\[\]]/.test(path))).toEqual([]);
    expect(new Set(found).size).toBe(found.length);
  });
});
