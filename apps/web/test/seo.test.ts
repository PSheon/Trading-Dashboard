import { describe, expect, it } from "vitest";

import manifest from "../src/app/manifest";
import robots, { DISALLOWED, PUBLIC_READS } from "../src/app/robots";
import { faqSections } from "../src/components/content/faq";
import { LOCALES } from "../src/i18n/config";
import { catalogs } from "../src/i18n/messages";
import { contentBlocks } from "../src/lib/content";
import { blocksText, faqJsonLd, pageSeo, siteJsonLd, webPageJsonLd } from "../src/lib/seo";
import { loadSitemapData } from "../src/lib/share-card-data";

describe("page metadata", () => {
  it("gives a public page its own title, description, canonical URL and link preview", () => {
    const meta = pageSeo("en", { path: "/explore", title: "Explore", description: "Browse traders." });
    expect(meta.title).toBe("Explore");
    expect(meta.description).toBe("Browse traders.");
    // The canonical URL is this language's; every language and x-default
    // (the unprefixed path, which redirects to the visitor's) are alternates.
    expect(meta.alternates?.canonical).toBe("/en/explore");
    expect(meta.alternates?.languages).toMatchObject({ en: "/en/explore", "zh-TW": "/zh-TW/explore", ja: "/ja/explore", "x-default": "/explore" });
    expect(Object.keys(meta.alternates?.languages ?? {})).toHaveLength(LOCALES.length + 1);
    expect(meta.robots).toEqual({ index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 });
    expect(meta.openGraph).toMatchObject({ type: "website", url: "/en/explore", title: "Explore | Orbie", description: "Browse traders.", locale: "en_US" });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", title: "Explore | Orbie" });
  });

  it("keeps personal pages out of the index and leaves a complete title alone", () => {
    expect(pageSeo("en", { path: "/portfolio", title: "Portfolio", description: "x", index: false }).robots).toEqual({ index: false, follow: true });
    expect(pageSeo("en", { path: "/", title: "Hyperliquid Copy Trading | Orbie", description: "x", absolute: true })).toMatchObject({
      title: { absolute: "Hyperliquid Copy Trading | Orbie" },
      openGraph: { title: "Hyperliquid Copy Trading | Orbie" },
    });
  });

  it("has a different description for every public page, in every language", () => {
    for (const locale of LOCALES) {
      const { pages, description, homeTitle, notFound } = catalogs[locale].meta;
      const all = [...Object.values(pages), description];
      expect(new Set(all).size, locale).toBe(all.length);
      expect(pages.trader, locale).toContain("{name}");
      expect(homeTitle && notFound, locale).toBeTruthy();
    }
  });
});

describe("robots.txt, the manifest and the sitemap's data", () => {
  it("disallows the back office, the lab, the api and the personal pages, and names the sitemap", () => {
    const file = robots();
    expect(file.rules).toEqual([{ userAgent: "*", allow: ["/", ...PUBLIC_READS], disallow: DISALLOWED }]);
    for (const path of ["/admin", "/dev", "/api/", "/settings", "/portfolio", "/favorites"]) expect(DISALLOWED).toContain(path);
    for (const locale of LOCALES) for (const path of ["/admin", "/dev", "/settings", "/portfolio", "/favorites"]) expect(DISALLOWED).toContain(`/${locale}${path}`);
    expect(file.sitemap).toMatch(/\/sitemap\.xml$/);
  });

  it("lets a renderer fetch the same-origin public reads the pages draw from, and nothing private", () => {
    const [rule] = [robots().rules].flat();
    const list = (v: string | string[] | undefined) => [v ?? []].flat();
    // Google's rule: the longest matching path wins; Allow wins a tie.
    const allowed = (path: string) => {
      const best = (paths: string[]) => Math.max(-1, ...paths.filter((p) => path.startsWith(p)).map((p) => p.length));
      return best(list(rule!.allow)) >= best(list(rule!.disallow));
    };
    for (const path of [
      "/explore", "/trader/0xab", "/coins/BTC",
      "/api/hl/discover/home", "/api/hl/discover/boards?board=top100", "/api/hl/discover/coins/BTC",
      "/api/hl/traders?window=allTime", "/api/hl/traders/0xab", "/api/hl/traders/0xab/activity", "/api/hl/traders/sparklines?addresses=0xab",
      "/api/hl/kols/0xab/avatar", "/api/hl/insights/crowd", "/api/hl/insights/cohorts/whale", "/api/hl/settings", "/api/hl/actions?limit=20",
      "/api/coin-icon/BTC",
    ]) expect(allowed(path), path).toBe(true);
    for (const path of [
      "/api/hl/me", "/api/hl/me/wallet", "/api/hl/me/settings", "/api/hl/copy/strategies", "/api/hl/admin/users",
      "/api/hl/actions/stream", "/api/hl/alerts", "/api/hl/lists", "/api/hl/referral/check/X",
      "/admin", "/dev/lab", "/settings", "/portfolio", "/favorites",
    ]) expect(allowed(path), path).toBe(false);
  });

  it("serves an installable manifest with its own 192 and 512 icons", () => {
    const file = manifest();
    expect(file).toMatchObject({ short_name: "Orbie", start_url: "/", display: "standalone" });
    expect(file.icons?.map((icon) => `${icon.src} ${icon.sizes} ${icon.purpose ?? ""}`.trim())).toEqual(["/icon-192.png 192x192", "/icon-512.png 512x512", "/icon-512.png 512x512 maskable"]);
  });

  it("lists markets and board traders from the api, each once, and nothing when the api is down", async () => {
    const a = `0x${"a".repeat(40)}`;
    const b = `0x${"B".repeat(40)}`;
    const api = (async (url: URL) => {
      const path = `${url.pathname}${url.search}`;
      if (path === "/discover/coins") return Response.json({ success: true, data: { items: [{ coin: "BTC" }, { coin: "xyz:TSLA" }, { coin: "BTC" }] } });
      if (path.startsWith("/discover/boards?board=kol")) return Response.json({ success: true, data: { items: [{ address: a }, { address: "not-an-address" }] } });
      if (path.startsWith("/discover/boards?")) return Response.json({ success: true, data: { items: [{ address: a }, { address: b }] } });
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await loadSitemapData({ apiUrl: "http://api.test", fetchImpl: api })).toEqual({ coins: ["BTC", "xyz:TSLA"], traders: [a, b.toLowerCase()] });
    const down = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    expect(await loadSitemapData({ apiUrl: "http://api.test", fetchImpl: down })).toEqual({ coins: [], traders: [] });
  });
});

describe("structured data", () => {
  it("describes the organisation, the site and the app on every page", () => {
    const graph = siteJsonLd("en", catalogs.en)["@graph"];
    expect(graph.map((node) => node["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication"]);
    expect(JSON.stringify(graph)).not.toMatch(/copydog/i);
    expect(graph[0]).toMatchObject({ name: "Orbie", logo: { width: 512, height: 512 } });
    // The site's URLs are the page language's.
    expect(graph[1]).toMatchObject({ url: expect.stringMatching(/\/en$/), inLanguage: "en" });
  });

  it("adds the about page as a WebPage of the site", () => {
    expect(webPageJsonLd({ locale: "zh-TW", name: "About", description: "d", path: "/about" })).toMatchObject({ "@type": "WebPage", isPartOf: { "@id": expect.stringMatching(/#website$/) }, url: expect.stringMatching(/\/zh-TW\/about$/) });
  });

  it("lists every FAQ question with a plain-text answer, in both written languages", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      const questions = faqSections(contentBlocks("faq", locale)).flatMap((section) => section.questions);
      const data = faqJsonLd(questions.map((q) => ({ question: q.question, answer: blocksText(q.answer) })));
      expect(data.mainEntity.length).toBe(questions.length);
      expect(questions.length).toBeGreaterThan(10);
      for (const entry of data.mainEntity) {
        expect(entry.name).toBeTruthy();
        expect(entry.acceptedAnswer.text.length, entry.name).toBeGreaterThan(10);
        expect(entry.acceptedAnswer.text).not.toMatch(/\*\*|\]\(/);
      }
    }
  });
});
