import { localeEnum } from "@trading-dashboard/shared/contracts";
import { describe, expect, it } from "vitest";

import { reasonGroup, renderCopyMessage } from "../src/notify/copy-message.js";
import { fill, telegramCatalogs, telegramMessages } from "../src/notify/messages/index.js";
import { zhTW } from "../src/notify/messages/zh-TW.js";

type Tree = { [key: string]: string | Tree };
const leaves = (tree: Tree, prefix = ""): Array<[string, string]> =>
  Object.entries(tree).flatMap(([k, v]) => (typeof v === "string" ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe("Telegram messages in the site's eleven languages", () => {
  const reference = new Map(leaves(zhTW as unknown as Tree));
  for (const locale of localeEnum) {
    it(`${locale} has exactly zh-TW's keys, each a non-empty string with the same placeholders`, () => {
      const catalog = new Map(leaves(telegramCatalogs[locale] as unknown as Tree));
      expect([...catalog.keys()].sort()).toEqual([...reference.keys()].sort());
      for (const [key, value] of catalog) {
        expect(value.trim(), `${locale} ${key}`).not.toBe("");
        expect(placeholders(value), `${locale} ${key}`).toEqual(placeholders(reference.get(key)!));
      }
    });
  }

  it("a paper message says it is simulated in every language, in its first line", () => {
    const event = { id: 7n, strategyId: 3, type: "order_filled", payload: { mode: "paper", coin: "ETH", side: "B", size: "1", px: "4000", action: "open" }, createdAt: new Date(Date.UTC(2026, 9, 4, 12, 30)) };
    for (const locale of localeEnum) {
      const first = renderCopyMessage(event, "https://app.orbie.fun", locale).split("\n")[0]!;
      expect(first).toBe(telegramMessages(locale).copy.header.paper);
    }
    expect(renderCopyMessage(event, "https://app.orbie.fun", "zh-TW").split("\n")).toEqual([
      "Orbie · 模擬跟單（虛擬資金，不是真實資金）", "🟢 已開倉", "買入 1 ETH @ $4,000", "2026-10-04 12:30 UTC", "事件 #7", "查看投資組合：https://app.orbie.fun/portfolio?copy=3",
    ]);
    // An unknown language falls back to English.
    expect(renderCopyMessage(event, "https://x", "xx").split("\n")[1]).toBe("🟢 Position opened");
  });

  it("reads only allowlisted fields: a coin name cannot become a link and other payload fields never show", () => {
    const text = renderCopyMessage({ id: 1n, strategyId: null, type: "funds_added", payload: { mode: "paper", amount: "250.50", note: "https://evil.example" }, createdAt: new Date() }, "https://x", "en");
    expect(text).toContain("Amount $250.5");
    expect(text).not.toContain("evil");
    const coin = renderCopyMessage({ id: 2n, strategyId: null, type: "order_filled", payload: { mode: "paper", coin: "evil.example/@x", side: "B", size: "1", px: "1" }, createdAt: new Date() }, "https://x", "en");
    expect(coin).not.toContain("evil.example");
  });

  it("groups every public order reason, and fills placeholders", () => {
    expect(reasonGroup("stale_signal_before_fill")).toBe("market");
    expect(reasonGroup("platform_paused")).toBe("paused");
    expect(reasonGroup("strategy_reduce_only_before_submit")).toBe("paused");
    expect(reasonGroup("reduce_only_no_position")).toBe("position");
    expect(reasonGroup("risk_cap_max_order_available_funds")).toBe("risk");
    expect(reasonGroup("below_min_after_max_coin_exposure")).toBe("risk");
    expect(reasonGroup("symbol_blocked")).toBe("symbol");
    expect(reasonGroup("strategy_settings_changed")).toBe("settings");
    expect(reasonGroup("frequency")).toBe("frequency");
    expect(reasonGroup("order_not_executed")).toBe("other");
    expect(fill("{a} and {b} and {c}", { a: 1, b: "x" })).toBe("1 and x and {c}");
  });
});
