// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PositionsTab } from "@/components/trader/trader-tabs";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import type { TraderProfileResponse } from "@/lib/contracts";
import { profileFor } from "@/fixtures/data";
import type { TradeShareSnapshot } from "@/components/trader/trade-share-dialog";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/trader/trade-share-dialog", () => ({
  TradeShareDialog: ({ snapshot }: { snapshot: TradeShareSnapshot }) => <div role="dialog">{snapshot.market}:{snapshot.pnl}:{snapshot.capturedAt}</div>,
}));

it("keeps the frozen share snapshot after live positions disappear", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const profile: TraderProfileResponse = JSON.parse(JSON.stringify(profileFor("0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f", false)));
  const render = (empty: boolean) => act(async () => root.render(<I18nProvider locale="en" messages={en}><PositionsTab profile={empty ? { ...profile, positions: [] } : profile} marks={{}} /></I18nProvider>));
  try {
    await render(false);
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Share position"]');
    expect(buttons.length).toBe(profile.positions.length * 2); // Desktop and mobile.
    await act(async () => buttons[0].click());
    const frozen = container.querySelector('[role="dialog"]')?.textContent;
    expect(frozen).toBeTruthy();
    await render(true);
    expect(container.querySelector('[role="dialog"]')?.textContent).toBe(frozen);
    expect(container.querySelectorAll('button[aria-label="Share position"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
