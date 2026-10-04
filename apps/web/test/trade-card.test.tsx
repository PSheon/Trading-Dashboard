import { writeFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as copyCard } from "../src/app/portfolio/share-image/route";
import { GET as traderImage } from "../src/app/trader/[address]/share-image/route";
import { cardPrice, cardSize, cells, chipText, compactPnl, heldText, heroPnl, pctText, type TradeCardData } from "../src/lib/trade-card";
import { loadCopyPosition, loadCopyTrade, loadLeaderPosition, loadLeaderTrade } from "../src/lib/trade-card-data";
import { renderTradeCard, tones } from "../src/lib/trade-card-image";
import { parseCardRequest } from "../src/lib/trade-card-params";

const A = "0xbf735d58bf735d58bf735d58bf735d58bf735d58";
const ok = (data: unknown) => Response.json({ success: true, data });

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("trade and position cards (CopyDog's Share Trade / Share Position)", () => {
  it("formats as CopyDog's card does, with the dollar sign its tall hero leaves out", () => {
    expect(heroPnl(42.744)).toBe("+$42.74");
    expect(heroPnl(-123.4)).toBe("-$123");
    expect(heroPnl(1234)).toBe("+$1.2K");
    expect(heroPnl(-2_500_000)).toBe("-$2.50M");
    expect(compactPnl(1234.5)).toBe("+$1,234.50");
    expect(compactPnl(-12_345)).toBe("-$12.3K");
    expect(compactPnl(1_234_567)).toBe("+$1.23M");
    expect(pctText(-4.84)).toBe("4.8%");
    expect(pctText(123.4)).toBe("123%");
    expect(cardPrice(116_980.25)).toBe("$116,980.3");
    expect(cardPrice(221.4)).toBe("$221.40");
    expect(cardPrice(0.00012346)).toBe("$0.0001235");
    expect(cardPrice(null)).toBe("—");
    expect(cardSize(0.042)).toBe("0.042");
    expect(cardSize(12_345)).toBe("12.35K");
    expect(heldText(33_600_000)).toBe("9h 20m");
    expect(heldText(2 * 86_400_000 + 3_600_000)).toBe("2d 1h");
    expect(chipText({ coin: "xyz:TSLA", side: "short", leverage: 4.6 })).toBe("TSLA · SHORT 5×");
    const trade: TradeCardData = { coin: "SOL", side: "long", leverage: null, pnl: 1, pnlPct: 1, entryPx: 210.1, exitPx: 221.4, markPx: null, size: 4.2, heldMs: 60_000, closed: true, paper: false };
    expect(cells(trade)).toEqual([["$210.10", "Entry"], ["$221.40", "Exit"], ["1m", "Held"]]);
    expect(cells({ ...trade, closed: false, exitPx: null, markPx: 230, heldMs: null })).toEqual([["$210.10", "Entry"], ["$230.00", "Mark"], ["4.2", "Size"]]);
    // Poster: mint for a gain, rose for a loss; App Card: navy with green / rose figures.
    expect(tones("poster", true).sheet).not.toBe(tones("poster", false).sheet);
    expect(tones("card", false).hero).toBe("#f4506f");
  });

  it("accepts only a known kind, style, format and well-formed id or market", () => {
    const p = (q: string, copy = false) => parseCardRequest(new URLSearchParams(q), copy);
    expect(p("kind=trade&id=-123456789&style=poster&format=portrait")).toEqual({ kind: "trade", id: "-123456789", style: "poster", format: "portrait" });
    expect(p("kind=trade&id=-12", true)).toBeNull(); // copy trade ids are positive
    expect(p("kind=position&coin=xyz:TSLA")).toEqual({ kind: "position", coin: "xyz:TSLA", strategyId: null, style: "card", format: "landscape" });
    expect(p("kind=position&coin=BTC", true)).toBeNull(); // the owner's position needs its copy
    expect(p("kind=position&coin=BTC&strategyId=7", true)).toMatchObject({ strategyId: 7 });
    expect(p("kind=trade&id=1&style=neon")).toBeNull();
    expect(p("kind=position&coin=<script>")).toBeNull();
    expect(p("kind=pnl&pnl=1000000")).toBeNull();
  });

  it("reads a trader's trade by id over the trades pages, and their position, from the api; the URL never carries figures", async () => {
    const pages: Record<string, unknown> = {
      "": { items: [{ id: "1", coin: "ETH", side: "long", status: "closed", entryPx: 1, exitPx: 2, size: 1, holdSeconds: 1, netPnl: 1 }], nextCursor: "100_1" },
      "100_1": { items: [{ id: "-77", coin: "SOL", side: "short", status: "closed", entryPx: 200, exitPx: 190, size: 2, holdSeconds: 7200, netPnl: 19.5 }], nextCursor: null },
    };
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      urls.push(String(url));
      const cursor = new URL(String(url)).searchParams.get("cursor") ?? "";
      if (String(url).includes("/trades")) return ok(pages[cursor]);
      return ok({ positions: [{ coin: "BTC", szi: -0.5, side: "short", entryPx: 100_000, positionValue: 49_000, unrealizedPnl: 1000, leverage: 10 }] });
    }) as unknown as typeof fetch;
    const trade = await loadLeaderTrade(A, "-77", { apiUrl: "http://api.test", fetchImpl, client: "203.0.113.9" });
    expect(trade).toEqual({ coin: "SOL", side: "short", leverage: null, pnl: 19.5, pnlPct: 4.875, entryPx: 200, exitPx: 190, markPx: null, size: 2, heldMs: 7_200_000, closed: true, paper: false });
    expect(urls[1]).toContain("cursor=100_1");
    expect(await loadLeaderTrade(A, "999", { apiUrl: "http://api.test", fetchImpl })).toBeNull();
    const position = await loadLeaderPosition(A, "BTC", { apiUrl: "http://api.test", fetchImpl });
    expect(position).toMatchObject({ coin: "BTC", side: "short", leverage: 10, pnl: 1000, pnlPct: 2, markPx: 98_000, size: 0.5, closed: false });
    expect(await loadLeaderPosition(A, "DOGE", { apiUrl: "http://api.test", fetchImpl })).toBeNull();
  });

  it("reads the owner's own copy trade and position with their Authorization header; an unpriced position has no card", async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      if (String(url).includes("/me/copy/trades")) return ok({ mode: "paper", items: [{ id: "55", coin: "BTC", side: "long", size: 2, entryPx: 105, exitPx: 120, pnl: 29.6, roiPct: 14.1, openedAt: "2026-10-04T00:00:00Z", closedAt: "2026-10-04T02:00:00Z" }] });
      return ok({ mode: "paper", strategies: [{ id: 3, positions: [{ coin: "ETH", size: -1, entryPx: 4000, markPx: 3900, unrealizedPnl: 100 }, { coin: "SOL", size: 1, entryPx: 200, markPx: null, unrealizedPnl: null }] }] });
    }) as unknown as typeof fetch;
    const opts = { apiUrl: "http://api.test", fetchImpl, authorization: "Bearer abc.def.ghi" };
    expect(await loadCopyTrade("55", opts)).toEqual({ coin: "BTC", side: "long", leverage: null, pnl: 29.6, pnlPct: 14.1, entryPx: 105, exitPx: 120, markPx: null, size: 2, heldMs: 7_200_000, closed: true, paper: true });
    expect(await loadCopyPosition(3, "ETH", opts)).toMatchObject({ side: "short", pnl: 100, pnlPct: 2.5, markPx: 3900, paper: true });
    expect(await loadCopyPosition(3, "SOL", opts)).toBeNull();
    expect(await loadCopyPosition(4, "ETH", opts)).toBeNull();
    expect(seen.every((v) => v === "Bearer abc.def.ghi")).toBe(true);
  });

  it("the owner's card route needs a session and never caches; the trader route 404s an unknown trade", async () => {
    vi.stubEnv("NEXT_API_URL", "http://api.test");
    const fetcher = vi.fn<typeof fetch>(async () => ok({ mode: "paper", items: [] }));
    vi.stubGlobal("fetch", fetcher);
    const anonymous = await copyCard(new NextRequest("http://web.test/portfolio/share-image?kind=trade&id=5", { headers: { "x-forwarded-for": "198.51.100.1" } }));
    expect(anonymous.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const missing = await copyCard(new NextRequest("http://web.test/portfolio/share-image?kind=trade&id=5", { headers: { authorization: "Bearer abcdefghijklmnop.qrstuvwxyz", "x-forwarded-for": "198.51.100.1" } }));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer abcdefghijklmnop.qrstuvwxyz");
    expect((await copyCard(new NextRequest("http://web.test/portfolio/share-image?kind=trade&id=abc"))).status).toBe(400);
    fetcher.mockImplementation(async () => ok({ items: [], nextCursor: null }));
    const unknown = await traderImage(new NextRequest(`http://web.test/trader/${A}/share-image?kind=trade&id=42`, { headers: { "x-forwarded-for": "198.51.100.2" } }), { params: Promise.resolve({ address: A }) });
    expect(unknown.status).toBe(404);
  });

  it("renders both styles in both formats to PNG, a paper card labelled as simulated", async () => {
    const trade: TradeCardData = { coin: "SOL", side: "long", leverage: null, pnl: 42.74, pnlPct: 4.84, entryPx: 210.1, exitPx: 221.4, markPx: null, size: 4.2, heldMs: 33_600_000, closed: true, paper: false };
    const position: TradeCardData = { coin: "xyz:TSLA", side: "short", leverage: 5, pnl: -1234.5, pnlPct: -12.3, entryPx: 250, exitPx: null, markPx: 280.75, size: 40, heldMs: null, closed: false, paper: true };
    for (const [d, name] of [[trade, "trade"], [position, "position-paper"]] as const) {
      for (const style of ["card", "poster"] as const) {
        for (const [format, w, h] of [["landscape", 1280, 720], ["portrait", 960, 1200]] as const) {
          const res = await renderTradeCard(d, style, format);
          const png = Buffer.from(await res.arrayBuffer());
          expect(res.headers.get("content-type")).toBe("image/png");
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
          if (process.env.SHARE_CARD_OUT) writeFileSync(`${process.env.SHARE_CARD_OUT}/orbie-${name}-${style}-${format}.png`, png);
        }
      }
    }
  }, 60_000);
});
