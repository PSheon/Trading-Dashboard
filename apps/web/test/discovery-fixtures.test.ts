import { describe, expect, it } from "vitest";
import { boardResponseSchema, homeBoardsResponseSchema } from "@trading-dashboard/shared/contracts";
import { fixtureBoard, fixtureHome } from "@/fixtures/discovery";

describe("discovery preview fixtures", () => {
  it("provides contract-valid home data and calculator series", () => {
    const home = homeBoardsResponseSchema.parse(fixtureHome());
    expect(home.crypto.length).toBeGreaterThan(0);
    expect(home.stocks.length).toBeGreaterThan(0);
    expect(home.calculator.every((trader) => trader.sparkline.length > 2)).toBe(true);
    expect(home.featured.every((trader) => trader.kol)).toBe(true);
  });

  it("filters by coin and style and orders results by the requested metric", () => {
    const board = boardResponseSchema.parse(fixtureBoard({ market: "crypto", board: "BTC", style: "swing", sort: "pnl", window: "30d" }));
    expect(board.items.length).toBeGreaterThan(0);
    expect(board.items.every((trader) => trader.topCoins.includes("BTC") && trader.style === "swing")).toBe(true);
    expect(board.items.map((trader) => trader.pnl)).toEqual(board.items.map((trader) => trader.pnl).sort((a, b) => (b ?? 0) - (a ?? 0)));
  });
});
