// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WithdrawDialog } from "../src/components/wallet/withdraw-dialog";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";

const state = vi.hoisted(() => ({
  pending: null as object | null, failRead: false, posts: [] as Array<{ path: string; body: unknown }>,
  walletReady: true, scope: "alice", switchAfterClaim: false, keepPrepared: false,
  sign: vi.fn(async () => `0x${"11".repeat(64)}1b`), fetch: vi.fn(),
}));
const MAIN = `0x${"11".repeat(20)}`;
const DEST = `0x${"22".repeat(20)}`;
const OP = { id: "11111111-1111-4111-8111-111111111111", network: "testnet", address: MAIN, destination: DEST, amount: "12.5", nonce: 1780000000000, status: "unknown", createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", wallet: { address: state.walletReady ? `0x${"11".repeat(20)}` : null, signTypedData: state.sign } }) }));
vi.mock("../src/lib/api", () => ({ api: {
  get: async (path: string) => {
    if (path === "/me/wallet/withdrawals/current") { if (state.failRead) throw new Error("offline"); return state.pending; }
    if (path === "/me/wallet") return { network: "testnet", address: `0x${"11".repeat(20)}`, hyperliquid: { perpValue: 100, withdrawable: 100, spotUsdc: 0, spotUsdcHold: 0 }, arbitrum: null, totalValue: 100, fetchedAt: "2026-10-03T00:00:00.000Z" };
    throw new Error("unexpected GET " + path);
  },
  post: async (path: string, body: unknown) => {
    state.posts.push({ path, body });
    if (path.endsWith("/broadcast")) {
      state.pending = { ...state.pending, status: "unknown" };
      if (state.switchAfterClaim) state.scope = "bob";
      return { operation: state.pending, claimed: true };
    }
    const status = path.endsWith("/cancel") ? "cancelled" : path.endsWith("/submit") ? "accepted" : state.keepPrepared ? "prepared" : "accepted";
    state.pending = { ...state.pending, status }; return state.pending;
  },
}, sessionKey: () => state.scope, apiErrorCode: () => undefined, isBusy: () => false }));
vi.mock("../src/components/ui/toast", () => ({ useToast: () => ({ info: () => "toast", dismiss() {}, success() {}, error() {} }) }));
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function View() {
  const [open, setOpen] = useState(true);
  return <QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><WithdrawDialog open={open} onOpenChange={setOpen} /></I18nProvider></QueryClientProvider>;
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); }
// A fixed 30 ms was not enough on CI's slower runners, and "nothing fetching"
// alone isn't either: the recovery read only starts once the wallet summary
// has answered and React has re-rendered, so between the two nothing is in
// flight. Wait until the recovery read itself has settled, then let React commit.
async function render() {
  await act(async () => root.render(<View />));
  await act(async () => { await vi.waitFor(() => {
    const recovery = client.getQueryCache().findAll({ queryKey: ["wallet", "withdrawal"] });
    if (client.isFetching() > 0 || !recovery.length || recovery.some((query) => query.state.status === "pending")) throw new Error("still loading");
  }, { timeout: 5000, interval: 10 }); });
  await settle();
}
function button(label: string) { return [...document.querySelectorAll("button")].find((item) => item.textContent === label)!; }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); state.pending = { ...OP }; state.failRead = false; state.posts = []; vi.clearAllMocks(); vi.stubGlobal("fetch", state.fetch);
  state.walletReady = true; state.scope = "alice"; state.switchAfterClaim = false; state.keepPrepared = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });

it("recovers another device's pending nonce, freezes its input and checks that ID without signing or broadcasting", async () => {
  await render();
  const inputs = [...document.querySelectorAll("input")];
  expect(inputs.map((input) => input.value)).toEqual([DEST, "12.5"]);
  expect(inputs.every((input) => input.disabled)).toBe(true);
  expect(document.body.textContent).toContain("1780000000000");
  await act(async () => button(en.wallet.checkWithdrawal).click()); await settle();
  expect(state.posts).toEqual([{ path: "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/reconcile", body: {} }]);
  expect(state.sign).not.toHaveBeenCalled(); expect(state.fetch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("blocks new submissions while durable recovery data has never been read", async () => {
  state.failRead = true;
  await render();
  const submit = document.querySelector('form button[type="submit"]') as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  await act(async () => submit.click());
  expect(state.sign).not.toHaveBeenCalled(); expect(state.fetch).not.toHaveBeenCalled();
});

it("a failed poll after a good read keeps that read: the pending withdrawal can still be looked up (web audit M7)", async () => {
  await render();
  state.failRead = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["wallet"] }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)); });
  expect(button(en.wallet.checkWithdrawal).disabled).toBe(false);
  expect(document.body.textContent).not.toContain(en.common.error);
});

it("lets the owner cancel unbroadcast preparation without a signature or exchange request", async () => {
  state.pending = { ...OP, status: "prepared" };
  await render();
  const cancel = [...document.querySelectorAll("button")].find((item) => item.textContent === "Cancel preparation");
  expect(cancel).toBeDefined();
  await act(async () => cancel!.click()); await settle();
  expect(state.posts).toEqual([{ path: "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/cancel", body: {} }]);
  expect([...document.querySelectorAll("input")].every((input) => !input.disabled)).toBe(true);
  expect(state.sign).not.toHaveBeenCalled(); expect(state.fetch).not.toHaveBeenCalled();
});

it("allows lookup-only recovery while the browser signing wallet is unavailable", async () => {
  state.walletReady = false;
  await render();
  expect(button(en.wallet.checkWithdrawal).disabled).toBe(false);
  await act(async () => button(en.wallet.checkWithdrawal).click()); await settle();
  expect(state.posts[0].path).toBe("/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/reconcile");
  expect(state.sign).not.toHaveBeenCalled(); expect(state.fetch).not.toHaveBeenCalled();
});

it("does not broadcast an already signed withdrawal after the account changes", async () => {
  state.pending = { ...OP, status: "prepared" }; state.keepPrepared = true; state.switchAfterClaim = true;
  await render();
  await act(async () => button(en.wallet.withdrawTitle).click()); await settle();
  expect(state.sign).toHaveBeenCalledTimes(1);
  expect(state.posts.map((item) => item.path)).toEqual([
    "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/reconcile",
    "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/broadcast",
  ]);
  expect(state.fetch).not.toHaveBeenCalled();
});

it("submits a resumed preparation through the owner API without a browser exchange request", async () => {
  state.pending = { ...OP, status: "prepared" }; state.keepPrepared = true;
  await render();
  await act(async () => button(en.wallet.withdrawTitle).click()); await settle();
  expect(state.sign).toHaveBeenCalledTimes(1);
  expect(state.posts.map((item) => item.path)).toEqual([
    "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/reconcile",
    "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/broadcast",
    "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/submit",
  ]);
  expect(state.posts[2].body).toEqual({ signature: `0x${"11".repeat(64)}1b` });
  expect(state.fetch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(localStorage.length).toBe(0);
  expect(document.body.textContent).not.toContain(`0x${"11".repeat(64)}1b`);
});

it("can cancel a lost claim response only when the server proves no exchange attempt was made", async () => {
  state.pending = { ...OP, canCancel: true };
  await render();
  await act(async () => button(en.wallet.cancelPreparation).click()); await settle();
  expect(state.posts).toEqual([{ path: "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/cancel", body: {} }]);
  expect(state.sign).not.toHaveBeenCalled(); expect(state.fetch).not.toHaveBeenCalled();
});

it("storage the browser blocks doesn't block withdrawals: the server's journal is read (web audit L9)", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
  try {
    state.pending = null;
    await render();
    expect(client.getQueryCache().findAll({ queryKey: ["wallet", "withdrawal"] }).every((query) => query.state.status === "success")).toBe(true);
    expect(document.body.textContent).not.toContain(en.common.error);
  } finally { Object.defineProperty(window, "localStorage", original); }
});
