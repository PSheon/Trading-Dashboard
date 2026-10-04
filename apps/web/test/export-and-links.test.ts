import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { describe, expect, it } from "vitest";

import { assertNoFixturesInProduction, assertPrivyInProductionBuild } from "../next.config";
import { isTelegramLinkUrl } from "../src/lib/alerts";
import { parseCsv, toCsv } from "../src/lib/csv";

describe("CSV export", () => {
  it("prefixes ' to text cells a spreadsheet would run as a formula", () => {
    const csv = toCsv(["coin", "note"], [
      ["=HYPERLINK(\"https://evil.example\",\"click\")", "+SUM(1,2)"],
      ["-2+3", "@cmd"],
      ["\tTAB", "\rCR"],
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("coin,note");
    expect(lines[1]).toBe(`"'=HYPERLINK(""https://evil.example"",""click"")","'+SUM(1,2)"`);
    expect(lines[2]).toBe("'-2+3,'@cmd");
    expect(csv).toContain("'\tTAB");
    expect(csv).toContain(`"'\rCR"`);
  });

  it("leaves numbers (negative PnL included) and ordinary text alone", () => {
    expect(toCsv(["pnl", "px", "coin", "dir"], [[-12.5, "-0.25", "BTC", "Close Long"], [1e-7, "-3e-7", "xyz:TSLA", "Open Short"]]))
      .toBe("pnl,px,coin,dir\r\n-12.5,-0.25,BTC,Close Long\r\n1e-7,-3e-7,xyz:TSLA,Open Short");
  });

  it("round-trips through the parser with the prefix visible", () => {
    expect(parseCsv(toCsv(["a", "b"], [["=1+1", "x"]]))).toEqual([{ a: "'=1+1", b: "x" }]);
  });
});

describe("Telegram link URL", () => {
  it("follows only the official https://t.me/ deep link", () => {
    expect(isTelegramLinkUrl("https://t.me/orbie_bot?start=abc_DEF-123")).toBe(true);
    for (const url of [
      "http://t.me/orbie_bot?start=abc",
      "https://t.me.evil.example/orbie_bot",
      "https://evil.example/?next=https://t.me/orbie_bot",
      "javascript:alert(1)//https://t.me/",
      "https://telegram.me/orbie_bot",
      "",
      42,
    ]) expect(isTelegramLinkUrl(url), String(url)).toBe(false);
  });
});

describe("fixture mode", () => {
  it("refuses a production build or server with NEXT_PUBLIC_API_FIXTURES=1", () => {
    const fixtures = { NEXT_PUBLIC_API_FIXTURES: "1", NODE_ENV: "development" } as NodeJS.ProcessEnv;
    expect(() => assertNoFixturesInProduction(PHASE_PRODUCTION_BUILD, fixtures)).toThrow(/NEXT_PUBLIC_API_FIXTURES/);
    expect(() => assertNoFixturesInProduction(PHASE_PRODUCTION_SERVER, fixtures)).toThrow(/NEXT_PUBLIC_API_FIXTURES/);
    expect(() => assertNoFixturesInProduction(PHASE_DEVELOPMENT_SERVER, { ...fixtures, NODE_ENV: "production" })).toThrow();
    expect(() => assertNoFixturesInProduction(PHASE_DEVELOPMENT_SERVER, fixtures)).not.toThrow();
    expect(() => assertNoFixturesInProduction(PHASE_PRODUCTION_BUILD, { NODE_ENV: "production" } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("refuses a production build without a Privy app id unless it says it is anonymous on purpose", () => {
    const env = (vars: Record<string, string>) => ({ NODE_ENV: "production", ...vars }) as NodeJS.ProcessEnv;
    expect(() => assertPrivyInProductionBuild(PHASE_PRODUCTION_BUILD, env({}))).toThrow(/NEXT_PUBLIC_PRIVY_APP_ID/);
    expect(() => assertPrivyInProductionBuild(PHASE_PRODUCTION_BUILD, env({ NEXT_PUBLIC_PRIVY_APP_ID: "  " }))).toThrow(/NEXT_PUBLIC_PRIVY_APP_ID/);
    expect(() => assertPrivyInProductionBuild(PHASE_PRODUCTION_BUILD, env({ NEXT_PUBLIC_PRIVY_APP_ID: "cm-app" }))).not.toThrow();
    expect(() => assertPrivyInProductionBuild(PHASE_PRODUCTION_BUILD, env({ NEXT_ALLOW_ANONYMOUS_BUILD: "1" }))).not.toThrow();
    // Development and the server phase are not builds.
    expect(() => assertPrivyInProductionBuild(PHASE_DEVELOPMENT_SERVER, env({}))).not.toThrow();
    expect(() => assertPrivyInProductionBuild(PHASE_PRODUCTION_SERVER, env({}))).not.toThrow();
  });
});
