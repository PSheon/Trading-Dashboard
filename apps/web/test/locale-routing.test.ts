import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { LOCALE_PATTERN, withLocales } from "../next.config";
import { LOCALES, PATH_HEADER, localePath, negotiateLocale, splitLocale } from "../src/i18n/config";
import { isUnprefixedRoute, proxy } from "../src/proxy";

const request = (path: string, init: { cookie?: string; language?: string } = {}) =>
  new NextRequest(`https://app.orbie.fun${path}`, {
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.language ? { "accept-language": init.language } : {}) },
  });

describe("locale paths", () => {
  it("prefixes a path with the locale, keeping the query and hash, and replaces one already there", () => {
    expect(localePath("zh-TW", "/")).toBe("/zh-TW");
    expect(localePath("en", "/explore?window=7d#top")).toBe("/en/explore?window=7d#top");
    expect(localePath("ja", "/?accountDeleted=1")).toBe("/ja?accountDeleted=1");
    expect(localePath("ja", "/en/trader/0xab")).toBe("/ja/trader/0xab");
    expect(localePath("en", "/zh-TW")).toBe("/en");
    expect(localePath("en", "https://t.me/orbie_fun_bot")).toBe("https://t.me/orbie_fun_bot");
    expect(localePath("en", "#copy")).toBe("#copy");
  });

  it("splits the locale off a path", () => {
    expect(splitLocale("/en/trader/0xab?x=1")).toEqual({ locale: "en", path: "/trader/0xab?x=1" });
    expect(splitLocale("/zh-TW")).toEqual({ locale: "zh-TW", path: "/" });
    expect(splitLocale("/zh-TW?x=1")).toEqual({ locale: "zh-TW", path: "/?x=1" });
    expect(splitLocale("/explore")).toEqual({ locale: null, path: "/explore" });
    expect(splitLocale("/english")).toEqual({ locale: null, path: "/english" });
  });

  it("picks the visitor's language from Accept-Language", () => {
    expect(negotiateLocale("ja-JP,ja;q=0.9,en;q=0.8")).toBe("ja");
    expect(negotiateLocale("fr-FR,fr;q=0.9,en-US;q=0.5")).toBe("en");
    expect(negotiateLocale("zh-HK")).toBe("zh-TW");
    expect(negotiateLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(negotiateLocale("zh-CN,zh;q=0.9")).toBe("zh-CN");
    expect(negotiateLocale("zh")).toBe("zh-CN");
    expect(negotiateLocale("pt-BR")).toBe("pt");
    expect(negotiateLocale("en;q=0.2,ko;q=0.8")).toBe("ko");
    expect(negotiateLocale("fr, de")).toBeNull();
    expect(negotiateLocale(null)).toBeNull();
  });
});

describe("the proxy's locale redirects", () => {
  const target = (response: Response) => response.headers.get("location")?.replace("https://app.orbie.fun", "");

  it("sends an unprefixed page to the cookie's language, then Accept-Language's, then zh-TW, keeping the query", () => {
    expect(target(proxy(request("/explore?window=7d", { cookie: "locale=ko", language: "ja" })))).toBe("/ko/explore?window=7d");
    expect(target(proxy(request("/trader/0xab", { language: "en-GB,en;q=0.9" })))).toBe("/en/trader/0xab");
    expect(target(proxy(request("/")))).toBe("/zh-TW");
    expect(target(proxy(request("/r/ABCD", { cookie: "locale=bogus" })))).toBe("/zh-TW/r/ABCD");
    expect(proxy(request("/explore")).status).toBe(307);
  });

  it("puts a locale in the wrong case right", () => {
    expect(target(proxy(request("/zh-tw/explore", { cookie: "locale=en" })))).toBe("/zh-TW/explore");
  });

  it("serves a prefixed page with its CSP and path header, and leaves the api, images and files alone", () => {
    const page = proxy(request("/en/explore"));
    expect(page.headers.get("location")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe("/en/explore");
    for (const path of ["/api/hl/settings", "/api/coin-icon/BTC", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/opengraph-image", "/twitter-image", "/apple-icon", "/icon-512.png", "/icon.svg", "/trader/0xab/opengraph-image", "/trader/0xab/twitter-image", "/trader/0xab/share-image", "/portfolio/share-image"]) {
      expect(isUnprefixedRoute(path), path).toBe(true);
      expect(proxy(request(path)).headers.get("location"), path).toBeNull();
    }
    for (const path of ["/", "/explore", "/trader/0xab", "/coins/xyz-TSLA", "/admin", "/dev/skeletons", "/iconic"]) expect(isUnprefixedRoute(path), path).toBe(false);
  });
});

describe("next.config redirects under a locale", () => {
  it("lists the same locales as the app", () => {
    expect(LOCALE_PATTERN.split("|").sort()).toEqual([...LOCALES].sort());
  });

  it("repeats every redirect under /:locale", () => {
    expect(withLocales([{ source: "/admin/revenue", destination: "/admin", permanent: false }, { source: "/login", destination: "/", permanent: false }])).toEqual([
      { source: "/admin/revenue", destination: "/admin", permanent: false },
      { source: `/:locale(${LOCALE_PATTERN})/admin/revenue`, destination: "/:locale/admin", permanent: false },
      { source: "/login", destination: "/", permanent: false },
      { source: `/:locale(${LOCALE_PATTERN})/login`, destination: "/:locale", permanent: false },
    ]);
  });
});
