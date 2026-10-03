// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CopyFundingSettings } from "@/components/settings/copy-funding";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import type { CopyExecutionAccount, CopyFunding, CopyFundingOverview } from "@trading-dashboard/shared/contracts";

const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), sign: vi.fn(), status: "signedIn", identity: "owner", session: "1", wallet: true }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: state.status, identity: state.identity, mode: "privy", wallet: state.wallet ? { address: `0x${"11".repeat(20)}`, signTypedData: state.sign } : null }) }));
vi.mock("@/lib/api", () => ({ api: { get: state.get, post: state.post }, sessionKey: () => state.session }));
vi.mock("@/lib/query-policy", () => ({ defaultRetry: { retry: false } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const account: CopyExecutionAccount = { id: "account", strategyId: 9, network: "testnet", state: "ready", address: `0x${"22".repeat(20)}`, issue: null, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
const op: CopyFunding = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", accountId: account.id, strategyId: 9, network: "testnet", address: `0x${"11".repeat(20)}`, destination: account.address!, amount: "10", nonce: 1780000000000, status: "prepared", canCancel: true, transactionHash: null, creditedAmount: null, fee: null, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
let root: Root, container: HTMLDivElement, client: QueryClient, data: CopyFundingOverview;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { status: "signedIn", identity: "owner", session: "1", wallet: true });
  state.get.mockReset(); state.post.mockReset(); state.sign.mockReset().mockResolvedValue(`0x${"11".repeat(64)}1b`);
  data = { available: true, network: "testnet", operations: [] }; state.get.mockImplementation(async () => data);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); }); }
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><CopyFundingSettings accounts={[account]} /></I18nProvider></QueryClientProvider>)); await settle(); }
function button(text: string) { const found = [...container.querySelectorAll("button")].find((item) => item.textContent === text); if (!found) throw new Error(`Missing button ${text}`); return found; }
async function click(text: string) { await act(async () => button(text).click()); await settle(); }
async function selectAccount() { await act(async () => { const select = container.querySelector("select")!; select.value = account.id; select.dispatchEvent(new Event("change", { bubbles: true })); }); }

it("loads without a transfer or signature and requires separate preparation and explicit signing", async () => {
  await render(); expect(state.post).not.toHaveBeenCalled(); expect(state.sign).not.toHaveBeenCalled();
  expect(button("Prepare funding").disabled).toBe(true); await selectAccount();
  state.post.mockImplementation(async (path: string) => {
    if (path.endsWith("/funding")) { data.operations = [op]; return op; }
    if (path.endsWith("/broadcast")) { data.operations = [{ ...op, status: "unknown", canCancel: true }]; return { claimed: true, operation: data.operations[0] }; }
    data.operations = [{ ...op, status: "accepted", canCancel: false }]; return data.operations[0];
  });
  await click("Prepare funding"); expect(state.sign).not.toHaveBeenCalled(); expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.post.mock.calls[0]).toEqual(["/me/copy/execution-wallets/account/funding", { amount: "10", idempotencyKey: expect.any(String) }]);
  expect(container.textContent).toContain("Receiving funds does not start copying");
  await click("Confirm and sign transfer");
  expect(state.sign).toHaveBeenCalledTimes(1); expect(state.post.mock.calls.map(([path]) => path)).toEqual(["/me/copy/execution-wallets/account/funding", `/me/copy/funding/${op.id}/broadcast`, `/me/copy/funding/${op.id}/submit`]);
  const typed = state.sign.mock.calls[0][0]; expect(typed.domain.chainId).toBe(421614); expect(typed.primaryType).toBe("HyperliquidTransaction:UsdSend"); expect(typed.message).toMatchObject({ destination: account.address, amount: "10", time: op.nonce });
  expect(container.textContent).toContain("Accepted, awaiting credit"); expect(button("Prepare funding").disabled).toBe(true);
});
it("recovers a pending server transfer without the signing SDK and shows actual net credit", async () => {
  state.wallet = false; data.operations = [{ ...op, status: "unknown", canCancel: false }];
  state.post.mockImplementation(async () => { data.operations = [{ ...op, status: "credited", canCancel: false, creditedAmount: "9", fee: "1", transactionHash: `0x${"aa".repeat(32)}` }]; return data.operations[0]; });
  await render(); await click("Check original transfer");
  expect(state.post).toHaveBeenCalledExactlyOnceWith(`/me/copy/funding/${op.id}/reconcile`, {}); expect(state.sign).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Credit confirmed"); expect(container.textContent).toContain("9 USDC"); expect(container.textContent).toContain("Transfer fee: 1 USDC");
});
it("preserves the same reservation key when its response is lost", async () => {
  state.post.mockRejectedValue(new Error("private provider error")); await render(); await selectAccount(); await click("Prepare funding");
  expect(container.textContent).not.toContain("private provider"); expect(container.querySelector("input")!.disabled).toBe(true);
  await click("Prepare funding"); expect(state.post).toHaveBeenCalledTimes(2); expect(state.post.mock.calls[0]).toEqual(state.post.mock.calls[1]); expect(state.sign).not.toHaveBeenCalled();
});
it("recovers a persisted reservation after response loss instead of preparing a second one", async () => {
  state.post.mockImplementationOnce(async () => { data.operations = [op]; throw new Error("response lost"); });
  await render(); await selectAccount(); await click("Prepare funding");
  expect(container.textContent).toContain("Awaiting signature"); expect(button("Prepare funding").disabled).toBe(true); expect(state.post).toHaveBeenCalledTimes(1); expect(state.sign).not.toHaveBeenCalled();
});
it("prevents old-owner submission when login changes during the signing prompt", async () => {
  data.operations = [op]; let complete!: (value: string) => void; state.sign.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  await render(); await click("Confirm and sign transfer");
  state.session = "2"; state.identity = "another-owner"; data.operations = []; await render();
  await act(async () => complete(`0x${"11".repeat(64)}1b`)); await settle();
  expect(state.post).not.toHaveBeenCalled(); expect(container.textContent).not.toContain(op.address);
});
it("does not sign for mainnet or a unavailable provider, and permits lookup of existing transfers", async () => {
  data = { available: false, network: "mainnet", operations: [{ ...op, network: "mainnet" }] }; await render();
  expect(button("Confirm and sign transfer").disabled).toBe(true); expect(container.querySelector("form")).toBeNull(); expect(state.sign).not.toHaveBeenCalled();
});
it("cancels only through the existing operation and never signs on cancellation", async () => {
  data.operations = [op]; state.post.mockImplementation(async () => { data.operations = [{ ...op, status: "cancelled", canCancel: false }]; return data.operations[0]; });
  await render(); await click("Cancel"); expect(state.post).toHaveBeenCalledExactlyOnceWith(`/me/copy/funding/${op.id}/cancel`, {}); expect(state.sign).not.toHaveBeenCalled(); expect(container.textContent).toContain("Cancelled");
});
it("does not load private funding while signed out", async () => {
  state.status = "signedOut"; await render(); expect(state.get).not.toHaveBeenCalled(); expect(state.post).not.toHaveBeenCalled();
});
