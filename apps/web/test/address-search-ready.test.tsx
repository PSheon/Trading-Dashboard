// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AddressSearch } from "../src/components/shell/address-search";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";

const state = vi.hoisted(() => ({ desktop: undefined as boolean | undefined }));
vi.mock("../src/lib/use-is-desktop", () => ({ useIsDesktop: () => state.desktop }));
vi.mock("../src/i18n/navigation", () => ({ useRouter: () => ({ push() {} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));
vi.mock("../src/lib/queries", () => ({ useDiscoverSearch: () => ({ data: undefined, isFetching: false, isSuccess: false, isPending: false }) }));
vi.mock("../src/components/discover/board-bits", () => ({ TraderAvatar: () => null }));
const view = () => <I18nProvider locale="en" messages={en}><AddressSearch compact /></I18nProvider>;

it("does not accept a mobile search click before hydration has resolved its layout", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.desktop = undefined;
  const server = document.createElement("div");
  server.innerHTML = renderToStaticMarkup(view());
  expect(server.querySelector("button")!.disabled).toBe(true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(view()));
    const trigger = container.querySelector("button")!;
    expect(trigger.disabled).toBe(true);
    await act(async () => trigger.click());
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    state.desktop = false;
    await act(async () => root.render(view()));
    expect(trigger.disabled).toBe(false);
    await act(async () => trigger.click());
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("button"));
  } finally { await act(async () => root.unmount()); container.remove(); }
});
