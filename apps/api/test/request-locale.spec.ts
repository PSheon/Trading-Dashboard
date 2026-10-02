import { describe, expect, it } from "vitest";

import { preferredLocale } from "../src/common/auth/request-locale.js";

describe("preferredLocale (Accept-Language → a supported language)", () => {
  it("takes the web app's own header as is", () => {
    for (const locale of ["en", "zh-TW", "zh-CN", "ko", "ja", "ru", "tr", "vi", "es", "pt", "id"]) expect(preferredLocale(locale)).toBe(locale);
  });

  it("maps a browser's tags: region to language, Chinese by script and region", () => {
    expect(preferredLocale("en-US,en;q=0.9")).toBe("en");
    expect(preferredLocale("pt-BR")).toBe("pt");
    expect(preferredLocale("zh-Hant-HK")).toBe("zh-TW");
    expect(preferredLocale("zh-HK")).toBe("zh-TW");
    expect(preferredLocale("zh-Hans")).toBe("zh-CN");
    expect(preferredLocale("zh")).toBe("zh-CN");
    expect(preferredLocale("ZH-tw")).toBe("zh-TW");
  });

  it("follows q-values, then order, and skips what is not supported", () => {
    expect(preferredLocale("fr-FR,de;q=0.9,ko;q=0.8,en;q=0.7")).toBe("ko");
    expect(preferredLocale("en;q=0.2,ja;q=0.9")).toBe("ja");
    expect(preferredLocale("en;q=0,vi")).toBe("vi");
  });

  it("gives nothing for a missing, empty, unsupported or oversized header", () => {
    expect(preferredLocale(undefined)).toBeUndefined();
    expect(preferredLocale("")).toBeUndefined();
    expect(preferredLocale("*")).toBeUndefined();
    expect(preferredLocale("fr,de")).toBeUndefined();
    expect(preferredLocale("en,".repeat(200))).toBeUndefined();
  });
});
