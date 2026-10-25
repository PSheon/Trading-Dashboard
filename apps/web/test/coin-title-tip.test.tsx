// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CoinBoardView, CoinIndexView } from "@/components/coins/coins-view";
import { zhTW } from "@/i18n/messages/zh-TW";
import { I18nProvider } from "@/i18n/provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/coins/BTC", notFound: () => { throw new Error("404"); } }));

/** The coin pages' subtitles live in the ⓘ beside the title (Paul,
 * 2026-10-25): no visible sentence under the heading. */
const parse = (node: React.ReactNode) => new DOMParser().parseFromString(
  renderToString(<QueryClientProvider client={new QueryClient()}><I18nProvider locale="zh-TW" messages={zhTW}>{node}</I18nProvider></QueryClientProvider>), "text/html");
/** Text a sighted reader sees: everything but screen-reader-only spans. */
const visible = (doc: Document) => {
  const body = doc.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return body.textContent ?? "";
};

describe("coin page titles", () => {
  it("/coins/BTC: the ranking sentence and the method are the title's ⓘ", () => {
    const doc = parse(<CoinBoardView coin="BTC" />);
    const body = zhTW.coins.body.replaceAll("{coin}", "BTC");
    expect(visible(doc)).not.toContain(body);
    const h1 = doc.querySelector("h1")!;
    expect(h1.textContent).toBe(zhTW.coins.title.replace("{coin}", "BTC"));
    const tip = h1.parentElement!.querySelector<HTMLButtonElement>(`button[aria-label="${zhTW.common.moreInfo}"]`)!;
    expect(doc.getElementById(tip.getAttribute("aria-describedby")!)!.textContent).toBe(body + zhTW.coins.method);
  });

  it("/coins: the index's sentence is the title's ⓘ", () => {
    const doc = parse(<CoinIndexView />);
    expect(visible(doc)).not.toContain(zhTW.coins.indexBody);
    const h1 = doc.querySelector("h1")!;
    const tip = h1.parentElement!.querySelector<HTMLButtonElement>(`button[aria-label="${zhTW.common.moreInfo}"]`)!;
    expect(doc.getElementById(tip.getAttribute("aria-describedby")!)!.textContent).toBe(zhTW.coins.indexBody);
  });
});
