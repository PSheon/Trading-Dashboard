// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { BoardsView } from "../src/components/explore/boards-view";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(location.search),
  useRouter: () => ({ refresh() {} }),
}));
vi.mock("../src/lib/queries", () => ({
  useSiteSettings: () => ({ data: undefined }),
  useBoard: () => ({ data: undefined, isError: false, isPending: true }),
}));

it("keeps Google callback parameters until Privy consumes them, including during filter changes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, "", "/explore?privy_oauth_code=test-code&privy_oauth_state=test-state&privy_oauth_provider=google&utm_source=test");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<I18nProvider locale="en" messages={en}><BoardsView /></I18nProvider>));
    const assertCallback = () => {
      const params = new URLSearchParams(location.search);
      expect(params.get("privy_oauth_code")).toBe("test-code");
      expect(params.get("privy_oauth_state")).toBe("test-state");
      expect(params.get("privy_oauth_provider")).toBe("google");
      expect(params.get("utm_source")).toBe("test");
    };
    assertCallback();
    const stocks = [...container.querySelectorAll("button")].find(button => button.textContent === "Stocks")!;
    await act(async () => stocks.click());
    assertCallback();
    expect(new URLSearchParams(location.search).get("market")).toBe("stocks");

    // Privy owns consumption. Later board changes must not resurrect credentials.
    history.replaceState(null, "", "/explore?market=stocks&sort=pnl&utm_source=test");
    const crypto = [...container.querySelectorAll("button")].find(button => button.textContent === "Crypto")!;
    await act(async () => crypto.click());
    const consumed = new URLSearchParams(location.search);
    expect(consumed.has("privy_oauth_code")).toBe(false);
    expect(consumed.has("privy_oauth_state")).toBe(false);
    expect(consumed.has("privy_oauth_provider")).toBe(false);
    expect(consumed.has("market")).toBe(false);
    expect(consumed.get("utm_source")).toBe("test");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    history.replaceState(null, "", "/");
  }
});
