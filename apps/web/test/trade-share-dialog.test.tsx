// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { TradeShareDialog, traderCardSource } from "../src/components/trader/trade-share-dialog";
import { ToastProvider } from "../src/components/ui/toast";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("insets the style row, the preview and the actions like the modal's title row (CopyDog's alignment)", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const source = traderCardSource(`0x${"ab".repeat(20)}`, "position", "BTC", "BTC");
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zhTW}><ToastProvider><TradeShareDialog source={source} onClose={() => {}} /></ToastProvider></I18nProvider>));
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const inset = (el: Element) => [...el.classList].filter((c) => /^px-\d/.test(c));
  const rows = [panel.querySelector('[role="radiogroup"]')!, panel.querySelector('[data-testid="trade-card-image"]')!.closest(".justify-center")!, panel.querySelector(".border-t-2")!];
  expect(inset(panel.querySelector("h2")!.parentElement!)).toEqual(["px-6"]);
  for (const row of rows) expect(inset(row), row.className).toEqual(["px-6"]);
  await act(async () => root.unmount());
  container.remove();
});
