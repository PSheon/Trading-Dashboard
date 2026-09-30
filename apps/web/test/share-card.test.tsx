import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  downsample,
  isShareFormat,
  isSharePeriod,
  shareCardData,
  shareFileName,
  shareImagePath,
  shareName,
  sharePnl,
  shareRoi,
  shareWinRate,
  sparklinePaths,
} from "../src/lib/share-card";
import { apiTarget, loadShareCard } from "../src/lib/share-card-data";
import { renderShareCard } from "../src/lib/share-card-image";

const A = "0xbf732ea04197942783e34730ed6e0f6099575d58";
const DAY = 86_400_000;

describe("share card data, CopyDog's", () => {
  it("formats the figures as CopyDog's card does", () => {
    expect([sharePnl(23_213_658.4), sharePnl(-759_587.2), sharePnl(0.3), sharePnl(null)]).toEqual(["+$23,213,658", "-$759,587", "$0", "—"]);
    expect([shareRoi(14.88), shareRoi(473.74), shareRoi(3.84), shareRoi(-0.097), shareRoi(1234.5), shareRoi(null)]).toEqual(["+1.5k%", "+47.4k%", "+384%", "-9.7%", "+123k%", "—"]);
    expect([shareWinRate(0.409), shareWinRate(0.29), shareWinRate(null)]).toEqual(["41%", "29%", "—"]);
  });

  it("names the trader: KOL name, then display name, then the short address", () => {
    expect(shareName({ address: A, kol: { displayName: "solanadoomer" }, displayName: "x" })).toBe("solanadoomer");
    expect(shareName({ address: A, displayName: " Farm " })).toBe("Farm");
    expect(shareName({ address: A })).toBe("0xbf73…5d58");
  });

  it("takes the period's last PnL, its ROI and win rate (all-time when the period has none)", () => {
    const pnl: Array<[number, number]> = Array.from({ length: 200 }, (_, i) => [i * DAY, i * 10]);
    const d = shareCardData({ address: A, period: "week", portfolio: { pnl, roi: 0.5 }, winRate: null, allTimeWinRate: 0.41 });
    expect(d).toMatchObject({ name: "0xbf73…5d58", pnl: 1990, roi: 0.5, winRate: 0.41, period: "week", avatar: null });
    expect(d.line).toHaveLength(60);
    expect(d.line.at(-1)).toBe(1990);
    expect(shareCardData({ address: A, period: "allTime", winRate: 0.29, allTimeWinRate: 0.41 }).winRate).toBe(0.29);
    expect(shareCardData({ address: A, period: "allTime" })).toMatchObject({ pnl: null, roi: null, winRate: null, line: [] });
    expect(downsample([1, 2, 3], 60)).toEqual([1, 2, 3]);
  });

  it("draws the line inside the box", () => {
    expect(sparklinePaths([1], 100, 50)).toBeNull();
    const p = sparklinePaths([0, 10, 5], 100, 50)!;
    expect(p.line).toBe("M0.0 50.0 L50.0 0.0 L100.0 25.0");
    expect(p.area.endsWith("L100 50 L0 50 Z")).toBe(true);
  });

  it("names files and paths, and accepts only known periods and formats", () => {
    expect(shareFileName("solana doomer!", "week", "portrait")).toBe("orbie-solanadoomer-7d-portrait");
    expect(shareFileName("交易員", "allTime", "landscape")).toBe("orbie-trader-all-landscape");
    expect(shareImagePath(A, "month", "landscape")).toBe(`/trader/${A}/share-image?period=month&format=landscape`);
    expect([isSharePeriod("allTime"), isSharePeriod("year"), isShareFormat("portrait"), isShareFormat("square")]).toEqual([true, false, true, false]);
  });
});

describe("share card server side", () => {
  it("keeps api reads under NEXT_API_URL", () => {
    expect(apiTarget("http://api:3002/v1/", "/traders/x")?.href).toBe("http://api:3002/v1/traders/x");
    expect(apiTarget("http://api:3002", "//evil.example/x")).toBeNull();
    expect(apiTarget("http://api:3002", "https://evil.example/x")).toBeNull();
    expect(apiTarget(undefined, "/x")).toBeNull();
    expect(apiTarget("ftp://api", "/x")).toBeNull();
  });

  it("reads profile, portfolio and analytics from the api and survives failures", async () => {
    const calls: string[] = [];
    const ok = (data: unknown) => new Response(JSON.stringify({ success: true, statusCode: 200, message: "", data, meta: {} }), { status: 200 });
    const fetchImpl = (async (url: URL) => {
      calls.push(url.pathname + url.search);
      if (url.pathname.endsWith("/portfolio")) return ok({ pnl: [[0, 0], [DAY, 5000]], roi: 1.2 });
      if (url.search.includes("window=7d")) return new Response("busy", { status: 503 });
      if (url.search.includes("window=all")) return ok({ summary: { winRate: 0.6 } });
      if (url.pathname.endsWith("/avatar")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      return ok({ displayName: null, kol: { displayName: "Farm", avatarUrl: "/kols/x/avatar?v=1" } });
    }) as unknown as typeof fetch;
    const d = await loadShareCard(A.toUpperCase().replace("0X", "0x"), "week", { apiUrl: "http://api:3002", fetchImpl });
    expect(d).toMatchObject({ name: "Farm", pnl: 5000, roi: 1.2, winRate: 0.6, avatar: "data:image/png;base64,AQID" });
    expect(calls).toContain(`/traders/${A}/portfolio?window=week&market=perp`);
    const empty = await loadShareCard(A, "allTime", { apiUrl: undefined });
    expect(empty).toMatchObject({ name: "0xbf73…5d58", pnl: null });
  });

  it("renders both formats to PNG", async () => {
    const line = Array.from({ length: 60 }, (_, i) => Math.sin(i / 8) * 1e5 + i * 4e5);
    const data = { address: A, name: "solanadoomer", avatar: null, period: "allTime" as const, pnl: 23_213_658, roi: 14.88, winRate: 0.409, line };
    for (const [format, w, h] of [["landscape", 1280, 720], ["portrait", 960, 1200]] as const) {
      const res = await renderShareCard(data, format);
      const png = Buffer.from(await res.arrayBuffer());
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
      if (process.env.SHARE_CARD_OUT) writeFileSync(`${process.env.SHARE_CARD_OUT}/orbie-share-${format}.png`, png);
    }
    const og = await renderShareCard({ ...data, pnl: -759_587, roi: -0.097, winRate: 0.29, period: "week" }, "landscape", { size: { width: 1200, height: 630 } });
    const png = Buffer.from(await og.arrayBuffer());
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    if (process.env.SHARE_CARD_OUT) writeFileSync(`${process.env.SHARE_CARD_OUT}/orbie-share-og-negative.png`, png);
  }, 30_000);
});
