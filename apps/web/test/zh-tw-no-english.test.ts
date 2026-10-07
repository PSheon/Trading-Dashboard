import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { catalogs } from "@/i18n/messages";
import { timeAgo } from "@/lib/format";

/**
 * English a zh-TW user saw (audit 2026-10-07 P1-12): 「Style」, 「3m ago」,
 * the keypad's 「Backspace」 and Privy's 「Log in or sign up」.
 */
const zh = catalogs["zh-TW"];

it("times since read 「2 分鐘前」 in Chinese; English keeps CopyDog's 52m ago", () => {
  const now = Date.UTC(2026, 9, 7, 12);
  expect(timeAgo(now - 2 * 60_000, now, "zh-TW")).toBe("2 分鐘前");
  expect(timeAgo(now - 3 * 3_600_000, now, "zh-TW")).toBe("3 小時前");
  expect(timeAgo(now - 52 * 60_000, now)).toBe("52m ago");
});

it("the catalog has no English where a zh-TW user reads it", () => {
  expect(zh.discover.styleLabel).toBe("風格");
  expect(zh.trader.copy.backspace).toBe("刪除");
  expect(zh.auth.landingHeader).toBe("登入或註冊");
  expect(zh.windows.allTime).toBe("全部");
});

it("Privy's sign-in title comes from the page's language", () => {
  const source = readFileSync(new URL("../src/lib/auth-privy.tsx", import.meta.url), "utf8");
  expect(source).toContain('landingHeader: t("auth.landingHeader")');
});
