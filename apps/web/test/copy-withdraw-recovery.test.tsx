// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WithdrawDialog } from "@/components/copy/copy-portfolio";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { fixtureCopyOverview } from "@/fixtures/copy";
import type { CopyStrategyView } from "@/lib/contracts";
const state = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", identity: "recovery-owner", mode: "fixture" }) }));
vi.mock("@/lib/api", () => ({ api: { post: state.post }, sessionKey: () => "1", apiErrorCode: () => "unknown", isBusy: () => false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/ui/dialog", () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
let root: Root, container: HTMLDivElement, client: QueryClient;
const close = vi.fn();
const storageKey = "orbie:copy-operations:withdraw:fixture:recovery-owner";
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear(); state.post.mockReset(); close.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); sessionStorage.clear(); });
async function render(strategy: CopyStrategyView) {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><WithdrawDialog strategy={strategy} open onClose={close} /></I18nProvider></QueryClientProvider>));
}
for (const amount of [400, 500]) it(`recovers original ${amount} withdrawal after response loss and reload with ${500 - amount} remaining`, async () => {
  const strategy: CopyStrategyView = JSON.parse(JSON.stringify({ ...fixtureCopyOverview().strategies[0], freeCollateralUsd: 500 - amount }));
  // Persisted before transmission; server accepted it and the response was lost.
  sessionStorage.setItem(storageKey, JSON.stringify([[JSON.stringify({ id: strategy.id, amountUsd: amount }), "original-operation-key"]]));
  state.post.mockRejectedValueOnce(new Error("still uncertain")).mockResolvedValueOnce(strategy);
  await render(strategy);
  const recovery = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Resolve withdrawal"))!;
  expect(recovery().disabled).toBe(false);
  expect(container.querySelectorAll("button")[1].disabled).toBe(true);
  await act(async () => recovery().click());
  expect(close).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Withdrawal outcome unconfirmed");
  await act(async () => recovery().click());
  expect(state.post).toHaveBeenCalledTimes(2);
  for (const call of state.post.mock.calls) expect(call[1]).toEqual({ amountUsd: amount, idempotencyKey: "original-operation-key" });
  expect(close).toHaveBeenCalledOnce();
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual([]);
});
