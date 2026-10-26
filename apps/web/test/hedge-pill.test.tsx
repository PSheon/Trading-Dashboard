// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { HedgeNotice } from "../src/components/copy/portfolio-parts";
import { I18nProvider } from "../src/i18n/provider";
import { catalogs } from "../src/i18n/messages";
import { LOCALES } from "../src/i18n/config";

/**
 * Paul, 2026-10-26: the 反向持倉 notice after a paper copy starts is one
 * warning pill (反向持倉 · BTC, ETH) and its close button; the sentence that
 * explains it is in the pill's hover tip only.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/trader" }));

const zh = catalogs["zh-TW"];
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.replaceChildren(); });

const pointer = (el: Element, type: string) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));

it("is one warning pill 反向持倉 · BTC, ETH with the close button; no paragraph; the explanation is in the hover tip", async () => {
  const onDismiss = vi.fn();
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zh}><HedgeNotice trader="0xab…cd" coins={["BTC", "xyz:ETH"]} onDismiss={onDismiss} /></I18nProvider>));
  const pill = container.querySelector<HTMLElement>('[data-testid="copy-hedge-pill"]');
  expect(pill).not.toBeNull();
  expect(pill!.className).toContain("bg-tag-warning");
  const body = zh.pf.hedge.body.replace("{trader}", "0xab…cd").replace("{coins}", "BTC, ETH");
  const visible = (pill!.textContent ?? "").replace(body, "");
  expect(visible).toBe("反向持倉 · BTC, ETH");
  expect(container.querySelectorAll("p")).toHaveLength(0);

  // The sentence: only in the tip (screen readers read it from its hidden span).
  const tip = pill!.querySelector("button")!;
  expect(document.getElementById(tip.getAttribute("aria-describedby")!)!.className).toContain("sr-only");
  expect(document.querySelector('[data-testid="info-tip-content"]')).toBeNull();
  await act(async () => { pointer(tip, "pointerover"); });
  expect(document.querySelector('[data-testid="info-tip-content"]')?.textContent).toBe(body);

  // Same dismiss.
  await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${zh.pf.hedge.dismiss}"]`)!.click(); });
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("has a short pill label in every locale", () => {
  for (const locale of LOCALES) {
    const { title, body } = catalogs[locale].pf.hedge;
    expect(title.length, locale).toBeLessThan(30);
    expect(body, locale).toContain("{coins}");
  }
  expect(catalogs["zh-TW"].pf.hedge.title).toBe("反向持倉");
  expect(catalogs["zh-CN"].pf.hedge.title).toBe("反向持仓");
});
