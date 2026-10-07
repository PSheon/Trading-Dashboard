import { afterEach, describe, expect, it, vi } from "vitest";

import type { TradeCardData } from "../src/lib/trade-card";

/**
 * B10 (Paul, 2026-10-07, audit §十一): the share card drew a ticker disc
 * ("PUMP" in orange) where the page shows PUMP's logo. The card now embeds
 * the very SVG the page's icon route serves, and keeps the disc for a coin
 * without one or an SVG the renderer can't draw.
 */
const svgs = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock("../src/lib/coin-icon-source", async (original) => ({
  ...(await original<typeof import("../src/lib/coin-icon-source")>()),
  coinIcons: { get: async (coin: string) => (svgs.map.has(coin) ? { svg: svgs.map.get(coin)! } : null) },
}));
vi.mock("../src/lib/client-address", () => ({ clientAddress: () => "1.2.3.4", iconRetryAfter: () => 0 }));

const { cardCoinIcon, renderTradeCard } = await import("../src/lib/trade-card-image");
const { GET: iconRoute } = await import("../src/app/api/coin-icon/[coin]/route");

const PUMP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#3fb68b"/><path d="M8 16h16" stroke="#fff" stroke-width="3"/></svg>`;
const decode = (uri: string) => Buffer.from(uri.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString();

afterEach(() => { svgs.map.clear(); vi.unstubAllEnvs(); });

describe("the share card's coin icon", () => {
  it("is the same SVG the page's /api/coin-icon/<coin> serves, embedded as a data URI", async () => {
    svgs.map.set("PUMP", PUMP);
    const page = await (await iconRoute(new Request("http://localhost/api/coin-icon/PUMP"), { params: Promise.resolve({ coin: "PUMP" }) })).text();
    const card = await cardCoinIcon("PUMP");
    expect(card).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(decode(card!)).toBe(page);
    expect(page).toBe(PUMP);
  });

  it("falls back to the ticker disc: no logo (a stock, a new market), or an SVG the renderer can't draw", async () => {
    expect(await cardCoinIcon("xyz:TSLA")).toBeNull();
    svgs.map.set("ODD", `<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="a" d="M0 0h1"/></defs><use href="#a"/></svg>`);
    expect(await cardCoinIcon("ODD")).toBeNull();
    svgs.map.set("TXT", `<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="10">T</text></svg>`);
    expect(await cardCoinIcon("TXT")).toBeNull();
  });

  it("renders the card with the logo (portrait and landscape)", async () => {
    svgs.map.set("PUMP", PUMP);
    const d: TradeCardData = { coin: "PUMP", side: "long", leverage: 10, pnl: 2_270_000, pnlPct: 14.98, entryPx: 0.005638, exitPx: null, markPx: 0.006484, size: 1, heldMs: null, closed: false, paper: false };
    for (const format of ["portrait", "landscape"] as const) {
      const res = await renderTradeCard(d, "card", format);
      const png = new Uint8Array(await res.arrayBuffer());
      expect(png.slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
    }
  }, 60_000);
});
