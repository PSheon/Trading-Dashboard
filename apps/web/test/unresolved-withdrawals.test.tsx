// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { UnresolvedWithdrawals } from "../src/components/admin/unresolved-withdrawals";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const state = vi.hoisted(() => ({ manage: true, items: [] as object[], posts: [] as Array<[string, unknown]> }));
vi.mock("../src/lib/auth", () => ({ usePermission: (p: string) => p === "users.read" || (p === "users.manage" && state.manage) }));
vi.mock("../src/lib/api", () => ({
  apiErrorCode: () => undefined,
  api: {
    get: async () => ({ items: state.items }),
    post: async (path: string, body: unknown) => { state.posts.push([path, body]); state.items = []; return { id: "w1", status: "not_executed", evidence: "ledger_absent_after_nonce_window" }; },
  },
}));
const item = (resolvableAt: number) => ({ id: "11111111-1111-4111-8111-111111111111", userId: 7, email: "alice@example.com", network: "testnet", address: `0x${"11".repeat(20)}`, destination: `0x${"22".repeat(20)}`, amount: "12.5", nonce: 1, attempted: true, createdAt: new Date(0).toISOString(), resolvableAt: new Date(resolvableAt).toISOString() });

let root: Root;
let container: HTMLDivElement;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.manage = true; state.items = []; state.posts = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async () => { await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><I18nProvider locale="en" messages={en}><UnresolvedWithdrawals /></I18nProvider></QueryClientProvider>)); await settle(); };
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);

it("shows nothing when no withdrawal is in doubt", async () => {
  await render();
  expect(container.textContent).toBe("");
});

it("lets an admin resolve one whose window has passed, with a reason, and reports the ledger's answer", async () => {
  state.items = [item(Date.now() - 1000)];
  await render();
  expect(container.querySelector('[data-slot="data-list"]')).not.toBeNull();
  expect(container.textContent).toContain("alice@example.com");
  await act(async () => button(en.admin.withdrawals.resolve)!.click());
  const input = document.querySelector<HTMLInputElement>("#withdrawal-reason")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "answer lost"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button(en.admin.withdrawals.confirm)!.click());
  await settle();
  expect(state.posts).toEqual([["/admin/wallet/withdrawals/11111111-1111-4111-8111-111111111111/resolve", { reason: "answer lost" }]]);
  expect(container.textContent).toContain(en.admin.withdrawals.notExecuted);
});

it("does not offer resolution inside the nonce window, nor to an operator", async () => {
  state.items = [item(Date.now() + 3_600_000)];
  await render();
  expect(button(en.admin.withdrawals.windowOpen)?.disabled).toBe(true);
  state.manage = false;
  await render();
  expect(button(en.admin.withdrawals.windowOpen)).toBeUndefined();
  expect(button(en.admin.withdrawals.resolve)).toBeUndefined();
});
