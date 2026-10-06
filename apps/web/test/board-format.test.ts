import { describe, expect, it } from "vitest";
import { boardCoinLabel, homeTiles, boardPnl, boardRoi, boardUsd, roiPillShort, roiPillWhole } from "../src/lib/board-format";
import { timeAgo } from "../src/lib/format";

describe("CopyDog board formats", () => {
  it("formats the grid card, list and home card figures as CopyDog does", () => {
    expect(boardPnl(5_959_218.4)).toBe("+$5,959,218");
    expect(boardPnl(-12_400)).toBe("-$12,400");
    expect(boardPnl(0.3)).toBe("$0");
    expect(boardRoi(8.9755)).toBe("+897.55%");
    expect(boardRoi(-0.031)).toBe("-3.10%");
    expect(boardUsd(2_636_620.4)).toBe("$2,636,620");
    expect(roiPillShort(38.17)).toBe("3817%");
    expect(roiPillShort(470)).toBe("47K%");
    expect(roiPillWhole(14.8612)).toBe("1,486%");
  });

  it("tags the last trade and names board coins", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(timeAgo("2026-09-27T11:00:00Z", now)).toBe("3d ago");
    expect(timeAgo("2026-09-30T11:08:00Z", now)).toBe("52m ago");
    expect(timeAgo(null, now)).toBeNull();
    const t = (k: "home.markets.gold" | "home.markets.oil") => (k === "home.markets.gold" ? "黃金" : "原油");
    expect(boardCoinLabel("xyz:SP500", t)).toBe("SPX");
    expect(boardCoinLabel("xyz:GOLD", t)).toBe("黃金");
    expect(boardCoinLabel("xyz:CL", t)).toBe("原油");
    expect(boardCoinLabel("BTC", t)).toBe("BTC");
    // CopyDog's home keeps "Gold" and "Oil" in English in every language.
    expect(boardCoinLabel("xyz:GOLD", t, "home")).toBe("Gold");
    expect(boardCoinLabel("xyz:CL", t, "home")).toBe("Oil");
  });

  it("lists the fixed home tiles, then trending markets not already there", () => {
    expect(homeTiles(["BTC", "ETH", "SOL", "HYPE", "DOGE"], ["ZEC", "PUMP"])).toEqual(["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "PUMP"]);
    expect(homeTiles(["xyz:SP500", "xyz:GOLD"], ["xyz:GOLD", "xyz:CBRS"])).toEqual(["xyz:SP500", "xyz:GOLD", "xyz:CBRS"]);
    expect(homeTiles(["BTC"], undefined)).toEqual(["BTC"]);
  });
});
