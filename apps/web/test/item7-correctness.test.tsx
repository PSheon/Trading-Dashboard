// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TraderName } from "../src/components/traders/trader-name";
import { coinIconUrl } from "../src/components/traders/coin-icon";
import { LOCALES } from "../src/i18n/config";
import { catalogs } from "../src/i18n/messages";
import { apiErrorKey } from "../src/lib/api-error-text";
import { createCoinIconSource, iconCandidates, isCoinName } from "../src/lib/coin-icon-source";
import { shortTime } from "../src/lib/trade-format";
import { useModalFocus } from "../src/lib/use-modal-focus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("an address in a narrow card", () => {
  it("is cut once: a head that may shrink and a tail that always shows", () => {
    const html = renderToStaticMarkup(<TraderName trader={{ displayName: null, address: "0x9871a3b3c4d5e6f708192a3b4c5d6e7f8091afc4" }} />);
    expect(html.match(/…/g)?.length).toBe(1);
    expect(html).toContain(">0x9871…<");
    expect(html).toMatch(/shrink-0[^>]*>afc4</);
  });
});

describe("market icons come from this origin", () => {
  it("points the page at the cached route, never at Hyperliquid's host", () => {
    expect(coinIconUrl("BTC")).toBe("/api/coin-icon/BTC");
    expect(coinIconUrl("xyz:TSLA")).toBe("/api/coin-icon/xyz%3ATSLA");
  });

  it("accepts only coin names, and tries the base coin for a k-market", () => {
    for (const ok of ["BTC", "kPEPE", "xyz:TSLA", "km:US500"]) expect(isCoinName(ok), ok).toBe(true);
    for (const bad of ["", "../etc", "a/b", "BTC.svg", "x".repeat(21), "XYZ:TSLA", "@107"]) expect(isCoinName(bad), bad).toBe(false);
    expect(iconCandidates("kPEPE")).toEqual(["kPEPE", "PEPE"]);
    expect(iconCandidates("kava")).toEqual(["kava"]);
  });

  it("fetches a coin once, keeps it, treats Hyperliquid's 200 text/html as no icon, and retries a failure sooner", async () => {
    let time = 0;
    const calls: string[] = [];
    const upstream = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/BTC.svg")) return new Response("<svg></svg>", { headers: { "content-type": "image/svg+xml" } });
      if (url.endsWith("/PEPE.svg")) return new Response("<svg id='pepe'></svg>", { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
      if (url.endsWith("/DOWN.svg")) throw new Error("network");
      return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const icons = createCoinIconSource({ fetchImpl: upstream, now: () => time });
    expect(await Promise.all([icons.get("BTC"), icons.get("BTC")])).toEqual([{ svg: "<svg></svg>" }, { svg: "<svg></svg>" }]);
    expect(await icons.get("BTC")).toEqual({ svg: "<svg></svg>" });
    expect(calls).toEqual(["https://app.hyperliquid.xyz/coins/BTC.svg"]);
    expect(await icons.get("kPEPE")).toEqual({ svg: "<svg id='pepe'></svg>" });
    expect(await icons.get("NOPE")).toBeNull();
    expect(await icons.get("NOPE")).toBeNull();
    expect(calls.filter((url) => url.includes("NOPE")).length).toBe(1);
    expect(await icons.get("../secret")).toBeNull();
    expect(calls.some((url) => url.includes("secret"))).toBe(false);
    expect(await icons.get("DOWN")).toBeNull();
    time += 61_000;
    await icons.get("DOWN");
    await icons.get("NOPE");
    expect(calls.filter((url) => url.includes("DOWN")).length).toBe(2);
    expect(calls.filter((url) => url.includes("NOPE")).length).toBe(1);
  });
});

describe("what a failed api call says", () => {
  it("is a catalog sentence by status, in every language — never the api's English", () => {
    expect(apiErrorKey({ status: 429 })).toBe("common.errors.rateLimited");
    expect(apiErrorKey({ status: 503 })).toBe("common.errors.busy");
    expect(apiErrorKey({ status: 400 })).toBe("common.errors.failed");
    expect(apiErrorKey(undefined)).toBe("common.errors.failed");
    for (const locale of LOCALES) for (const text of Object.values(catalogs[locale].common.errors)) expect(text.length, locale).toBeGreaterThan(5);
  });
});

describe("times", () => {
  it("a trade's time is written in UTC, whatever the viewer's zone", () => {
    expect(shortTime("2026-09-18T22:52:00Z")).toBe("Sep 18, 22:52");
  });
});

describe("overlay focus", () => {
  function Overlay({ onClose }: { onClose: () => void }) {
    const ref = useModalFocus<HTMLDivElement>(true, onClose);
    return (
      <div ref={ref} role="dialog">
        <button id="first">first</button>
        <button id="last">last</button>
      </div>
    );
  }

  it("moves focus in, keeps Tab inside, closes on Escape and gives focus back", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const host = document.createElement("div");
    document.body.append(host);
    // happy-dom has no layout: every element counts as on screen.
    const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const onClose = vi.fn();
    const root = createRoot(host);
    await act(async () => root.render(<Overlay onClose={onClose} />));
    expect(document.activeElement?.id).toBe("first");

    const tab = (shiftKey: boolean) => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
    tab(true);
    expect(document.activeElement?.id).toBe("last");
    tab(false);
    expect(document.activeElement?.id).toBe("first");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(opener);
    rects.mockRestore();
  });
});
