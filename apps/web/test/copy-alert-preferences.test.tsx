// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TradingBotRow } from "@/components/settings/bot-rows";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { settleQueries } from "./query-settle";
const state = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn" }) }));
vi.mock("@/lib/api", () => ({ api: { get: state.get, patch: state.patch } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
let root: Root, container: HTMLDivElement, client: QueryClient;
const linked = { bot: "orbie_test", linked: true, enabled: true, copyAlertsEnabled: false, username: "owner", linkedAt: "2026-10-03T00:00:00Z" };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.get.mockReset(); state.patch.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><TradingBotRow /></I18nProvider></QueryClientProvider>); });
  await settle();
}
// Waits for the preference read and the save to answer, then lets React commit.
const settle = () => settleQueries(client, { ms: 10 });
it("requires a linked enabled channel and labels notifications as paper", async () => {
  state.get.mockResolvedValue({ ...linked, linked: false, enabled: false });
  await render();
  expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
  expect(container.textContent).toContain("paper-copy");
  expect(state.patch).not.toHaveBeenCalled();
});
it("saves opt-in only on explicit action and retains the confirmed preference on failure", async () => {
  state.get.mockResolvedValue(linked);
  state.patch.mockResolvedValueOnce({ ...linked, copyAlertsEnabled: true }).mockRejectedValueOnce(new Error("lost"));
  await render();
  const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(state.patch).not.toHaveBeenCalled();
  await act(async () => toggle().click()); await settle();
  expect(state.patch).toHaveBeenCalledWith("/me/telegram/copy-alerts", { enabled: true });
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle().click()); await settle();
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
});
