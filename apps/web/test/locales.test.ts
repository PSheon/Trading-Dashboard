import { describe, expect, it } from "vitest";

import { LOCALE_NAMES, LOCALES, isLocale, numberLocale } from "@/i18n/config";
import { catalogs } from "@/i18n/messages";
import { zhTW } from "@/i18n/messages/zh-TW";
import { createFormatter } from "@/lib/format";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === "string" ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
}

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe("languages", () => {
  it("lists CopyDog's eleven languages, in its menu order, each in its own name", () => {
    expect(LOCALES.map((l) => LOCALE_NAMES[l])).toEqual([
      "English",
      "繁體中文",
      "简体中文",
      "한국어",
      "日本語",
      "Русский",
      "Türkçe",
      "Tiếng Việt",
      "Español",
      "Português",
      "Bahasa Indonesia",
    ]);
    expect(isLocale("ko")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });

  const reference = new Map(leaves(zhTW as unknown as Tree));

  for (const locale of LOCALES) {
    it(`${locale} has exactly zh-TW's keys, every leaf a non-empty string with the same placeholders`, () => {
      const catalog = new Map(leaves(catalogs[locale] as unknown as Tree));
      expect([...catalog.keys()].sort()).toEqual([...reference.keys()].sort());
      for (const [key, value] of catalog) {
        expect(value.trim(), key).not.toBe("");
        expect(placeholders(value), key).toEqual(placeholders(reference.get(key)!));
      }
    });
  }

  it("keeps CopyDog's dollars and percentages in every language; dates follow the language", () => {
    const at = Date.UTC(2026, 8, 30, 12, 0);
    for (const locale of LOCALES) {
      const f = createFormatter(locale);
      expect(f.usd(6_293_415.05, { digits: 2 })).toBe("$6,293,415.05");
      expect(f.usd(17_140_000_000, { compact: true })).toBe("$17.1B");
      expect(f.pct(0.3789, { digits: 2 })).toBe("37.89%");
      expect(numberLocale(locale)).toBe(locale === "zh-TW" ? "zh-TW" : "en-US");
      expect(f.date(at)).not.toBe("—");
    }
    expect(createFormatter("ru").date(at)).toMatch(/сентября 2026/);
    expect(createFormatter("ja").date(at)).toBe("2026年9月30日");
  });
});
