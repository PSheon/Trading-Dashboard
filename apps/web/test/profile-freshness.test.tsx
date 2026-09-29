// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { ProfileQuality } from "../src/components/trader/profile-quality";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
it("ages a snapshot while mounted without waiting for another REST response", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider locale="en" messages={en}><ProfileQuality quality={{ partial: false, sources: {
      prices: { status: "available", asOf: "2026-09-29T10:00:00.000Z", stale: false, maxAgeMs: 30000 },
    } }} /></I18nProvider>); });
    expect(container.textContent).not.toContain("Older cached data");
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(container.textContent).toContain("Older cached data");
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});
