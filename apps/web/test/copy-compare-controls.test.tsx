// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CopyCompare } from "@/components/copy/copy-compare";
import { fixtureCopyOverview } from "@/fixtures/copy";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import type { CopyStrategyView } from "@/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/copy", () => ({ useCopyPerformance: () => ({ data: undefined, isPending: false, isError: false }) }));
vi.mock("@/lib/queries", () => ({ usePortfolio: () => ({ data: undefined, isPending: false, isError: false }) }));

it("lets keyboard users switch comparison views with one tab stop and arrow keys", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    const strategy = fixtureCopyOverview().strategies[0]! as unknown as CopyStrategyView;
    await act(async () => root.render(<I18nProvider locale="en" messages={en}><CopyCompare strategy={strategy} traderName="Test trader" /></I18nProvider>));
    const group = container.querySelector('[role="radiogroup"]')!;
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map(radio => radio.tabIndex)).toEqual([0, -1]);
    radios[0].focus();
    await act(async () => radios[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(radios.map(radio => radio.tabIndex)).toEqual([-1, 0]);
    await act(async () => radios[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(radios[0]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
