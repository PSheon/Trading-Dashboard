import { coinBoardResponseSchema, coinIndexResponseSchema } from "@trading-dashboard/shared/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toUtcInput, fromUtcInput } from "../src/components/admin/settings-form";
import { CoinBoardView } from "../src/components/coins/coins-view";
import { FIXTURE_UNTRADED_MARKETS, fixtureCoinBoard, fixtureCoinIndex } from "../src/fixtures/discovery";
import { LOCALES, TIME_ZONE, TIME_ZONE_LABEL } from "../src/i18n/config";
import { catalogs } from "../src/i18n/messages";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { I18nProvider } from "../src/i18n/provider";
import { coinIsUnknown } from "../src/lib/coin-presence";
import { createFormatter } from "../src/lib/format";
import { pnlCalendar } from "../src/lib/pnl-calendar";
import { feedTime, shortTime } from "../src/lib/trade-format";

/** Owner's decisions of 2026-10-02: one form of address and one word for
 * trader; a real market without data is a page, not a 404; every time is UTC. */

type Tree = { [key: string]: string | Tree };
const leaves = (tree: Tree, prefix = ""): Array<[string, string]> =>
  Object.entries(tree).flatMap(([k, v]) => (typeof v === "string" ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));

describe("wording", () => {
  it("繁中 says 你 and 交易員 everywhere, never 您 or 交易者", () => {
    for (const [key, text] of leaves(catalogs["zh-TW"] as unknown as Tree)) {
      expect(text, key).not.toMatch(/您/);
      expect(text, key).not.toMatch(/交易者/);
    }
  });

  it("简中 says 你 and 交易员 everywhere, never 您 or 交易者", () => {
    for (const [key, text] of leaves(catalogs["zh-CN"] as unknown as Tree)) {
      expect(text, key).not.toMatch(/您/);
      expect(text, key).not.toMatch(/交易者/);
    }
  });

  it("the signed-out prompts say the same thing on a phone and on a desktop", () => {
    expect(zhTW.portfolio.signInTitle).toBe(zhTW.portfolio.signInTitlePhone);
    for (const key of ["signInBody", "signInBodyPhone"] as const) expect(zhTW.portfolio[key]).toMatch(/你|交易員/);
    expect(zhTW.favorites.phoneSavedTitle).toContain("交易員");
    expect(zhTW.favorites.signInBody).toContain("交易員");
  });

  it("settings never mentions billing, which does not exist, in any language", () => {
    const billing = /帳單|账单|billing|factur|cobran|penagihan|請求|결제|оплат|ödeme|thanh toán/i;
    for (const locale of LOCALES) expect(catalogs[locale].settings.signInBody, locale).not.toMatch(billing);
  });

  it("the other languages keep one register and one word for trader", () => {
    const text = (locale: (typeof LOCALES)[number]) => leaves(catalogs[locale] as unknown as Tree);
    for (const [key, value] of text("id")) expect(value, key).not.toMatch(/\bAnda\b/);
    for (const [key, value] of text("vi")) expect(value, key).not.toMatch(/nhà giao dịch/i);
    // Turkish addresses the reader as "siz"; the phone prompts used "sen".
    const tr = catalogs.tr;
    expect(tr.portfolio.signInTitlePhone).toMatch(/yapın$/);
    expect(tr.favorites.phoneSavedTitle).toMatch(/yapın$/);
    expect(tr.favorites.phoneAlertsBody).toContain("trader");
    expect(catalogs.es.portfolio.signInTitlePhone).toContain("portafolio");
    for (const [key, value] of text("en")) expect(value, key).not.toMatch(/\blog in\b/i);
  });
});

describe("times are UTC", () => {
  const at = "2026-09-18T22:52:30Z"; // 06:52 on the 19th in Taipei

  it("the site's zone and its label are UTC", () => {
    expect(TIME_ZONE).toBe("UTC");
    expect(TIME_ZONE_LABEL).toBe("UTC");
  });

  it("every formatter writes the UTC clock, in every language", () => {
    expect(shortTime(at)).toBe("Sep 18, 22:52");
    expect(feedTime(at)).toBe("Sep 18 10:52PM");
    for (const locale of LOCALES) {
      const f = createFormatter(locale);
      expect(f.time(at), locale).toMatch(/22.52.30/);
      expect(f.dateTime(at), locale).toMatch(/18/);
      expect(f.dateTime(at), locale).toMatch(/22.52/);
      expect(f.axisDate(at, "hours"), locale).toMatch(/^22.52$/);
    }
    expect(createFormatter("en").date(at)).toBe("September 18, 2026");
    expect(createFormatter("zh-TW").dateTime(at)).toBe("2026/09/18 22:52");
  });

  it("the PnL calendar's months are UTC months", () => {
    // 2026-08-31 23:30 UTC is already September in Taipei.
    const cal = pnlCalendar([[Date.UTC(2026, 7, 1), 0], [Date.UTC(2026, 7, 31, 23, 30), 100], [Date.UTC(2026, 8, 1, 0, 30), 150]], undefined)!;
    expect(cal.rows[0].months[7]?.pnl).toBe(100);
    expect(cal.rows[0].months[8]?.pnl).toBe(50);
  });

  it("the admin's maintenance end time is typed and read back in UTC", () => {
    expect(toUtcInput("2026-10-03T04:30:00.000Z")).toBe("2026-10-03T04:30");
    expect(fromUtcInput("2026-10-03T04:30")).toBe("2026-10-03T04:30:00.000Z");
    expect(toUtcInput(null)).toBe("");
    expect(fromUtcInput("")).toBeNull();
    expect(fromUtcInput("not a time")).toBeNull();
  });
});

const board = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), notFound }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("../src/lib/queries", () => ({ useCoinBoard: () => board.result, useCoinIndex: () => board.result }));

describe("/coins/<market>", () => {
  const render = (coin: string) => renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><CoinBoardView coin={coin} /></I18nProvider>);
  beforeEach(() => { notFound.mockClear(); });

  it("a real Hyperliquid market none of our traders has traded shows CopyDog's empty state, not the 404", () => {
    const data = fixtureCoinBoard("MEGA");
    expect(data).toMatchObject({ listed: true, items: [] });
    board.result = { data, isError: false };
    const html = render("MEGA");
    expect(notFound).not.toHaveBeenCalled();
    expect(html).toContain("Hyperliquid 上最強的 MEGA 交易員");
    expect(html).toContain("尚無市場資料。");
    // As on CopyDog: no totals and no table for a market without data.
    expect(html).not.toContain("<table");
    expect(html).not.toContain(zhTW.coins.listed);
  });

  it("a HIP-3 market without data is the same page", () => {
    board.result = { data: fixtureCoinBoard("xyz:AAPL"), isError: false };
    expect(render("xyz:AAPL")).toContain("尚無市場資料。");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("a name that is no Hyperliquid market is the 404", () => {
    const data = fixtureCoinBoard("NOPE123");
    expect(data.listed).toBe(false);
    board.result = { data, isError: false };
    expect(() => render("NOPE123")).toThrow("NEXT_NOT_FOUND");
    expect(coinIsUnknown(fixtureCoinBoard("xyz:NOPE"))).toBe(true);
  });

  it("a market with traders has its totals and table", () => {
    board.result = { data: JSON.parse(JSON.stringify(fixtureCoinBoard("BTC"))), isError: false };
    const html = render("BTC");
    expect(html).toContain("<table");
    expect(html).toContain(zhTW.coins.listed);
    expect(html).not.toContain("尚無市場資料");
  });

  it("the fixtures match the contract", () => {
    for (const coin of ["BTC", "xyz:TSLA", ...FIXTURE_UNTRADED_MARKETS, "NOPE123"]) coinBoardResponseSchema.parse(fixtureCoinBoard(coin));
    expect(coinIndexResponseSchema.parse(fixtureCoinIndex()).items.length).toBeGreaterThan(3);
  });
});
