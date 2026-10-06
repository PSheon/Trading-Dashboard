// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionWalletSettings } from "@/components/settings/execution-wallets";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { fixtureCopyOverview } from "@/fixtures/copy";
import type { ExecutionWallet, ExecutionWalletOverview, WalletAuthorization } from "@/lib/copy-execution-wallets";
import { flush as flushFor, settleQueries, type SettleOptions } from "./query-settle";
import { chooseOption, selectTrigger } from './select-helper';

const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), status: "signedIn" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: state.status, identity: "wallet-owner", mode: "fixture" }) }));
vi.mock("@/lib/api", () => ({ api: { get: state.get, post: state.post }, sessionKey: () => "1", isBusy: () => false }));
vi.mock("@/lib/query-policy", () => ({ defaultRetry: { retry: false } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const account: ExecutionWallet = {
  id: "private-wallet-reference", strategyId: 9, network: "testnet", state: "unknown", address: null,
  createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z", issue: "verification_pending",
};
const authorization: WalletAuthorization = {
  id: "private-authorization-reference", strategyId: 9, network: "testnet", accountAddress: "0x" + "1".repeat(40), signerAddress: "0x" + "2".repeat(40),
  status: "active", scopes: ["copy:trade", "copy:reduce"], expiresAt: "2026-11-03T00:00:00Z", revokedAt: null,
};
let root: Root, container: HTMLDivElement, client: QueryClient, overview: ExecutionWalletOverview;
const copies = { ...fixtureCopyOverview(), strategies: [{ ...fixtureCopyOverview().strategies[0], id: 9 }] };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.status = "signedIn";
  state.get.mockReset(); state.post.mockReset();
  overview = { available: true, network: "testnet", accounts: [], authorizations: [] };
  state.get.mockImplementation(async (path: string) => path === "/me/copy/funding" ? { available: false, network: "testnet", operations: [] } : path === "/me/copy" ? copies : overview);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
// Waits for the wallet queries and mutations to answer; flush() is a plain wait
// for the one test that holds a read open, settleHeld() for a held POST.
const settle = (options?: SettleOptions) => settleQueries(client, { ms: 15, ...options });
const settleHeld = () => settle({ mutations: false });
const flush = () => flushFor(15);
async function render(wait: () => Promise<void> = settle) {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><ExecutionWalletSettings /></I18nProvider></QueryClientProvider>));
  await wait();
}
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}
async function click(text: string, wait: () => Promise<void> = settle) { await act(async () => button(text).click()); await wait(); }
async function selectCopy() {
  await act(async () => {
    await chooseOption(selectTrigger(container), "9");
  });
}

it("loads without preparing a wallet, requires a selected owned copy and sends the current network only on click", async () => {
  await render();
  expect(state.get.mock.calls.map((call) => call[0])).toContain("/me/copy/execution-wallets");
  expect(state.post).not.toHaveBeenCalled();
  expect(button("Prepare dedicated wallet").disabled).toBe(true);
  expect(container.textContent).toContain("owned by you");
  expect(container.textContent).toContain("does not fund it or enable live trading");
  await selectCopy();
  expect(state.post).not.toHaveBeenCalled();
  state.post.mockImplementationOnce(async () => { overview = { ...overview, accounts: [account] }; return account; });
  await click("Prepare dedicated wallet");
  expect(state.post).toHaveBeenCalledExactlyOnceWith("/me/copy/strategies/9/execution-wallet", { network: "testnet" });
  expect(button("Wallet already prepared").disabled).toBe(true);
  expect(container.textContent).toContain("Outcome unconfirmed");
});

it("shows loading and read failures with a working retry", async () => {
  let reject!: (error: Error) => void;
  state.get.mockImplementation((path: string) => path === "/me/copy" ? Promise.resolve(copies) : new Promise((_, rejectPromise) => { reject = rejectPromise; }));
  await render(flush);
  expect(container.textContent).toContain("Loading execution wallets");
  expect(state.post).not.toHaveBeenCalled();
  await act(async () => reject(new Error("provider details must stay private"))); await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load execution wallets.");
  expect(container.textContent).not.toContain("provider details");
  state.get.mockImplementation(async (path: string) => path === "/me/copy" ? copies : overview);
  await click("Retry");
  expect(selectTrigger(container)).not.toBeNull();
});

it("recovers uncertain creation through the existing wallet without retrying creation or displaying funding controls", async () => {
  await render(); await selectCopy();
  state.post.mockImplementationOnce(async () => {
    overview = { ...overview, accounts: [{ ...account, address: authorization.accountAddress }] };
    throw new Error("response lost");
  });
  await click("Prepare dedicated wallet");
  expect(container.textContent).toContain("The action could not be confirmed");
  expect(container.textContent).toContain("Do not send funds");
  expect(button("Wallet already prepared").disabled).toBe(true);
  expect(container.querySelector("img, canvas")).toBeNull();
  expect([...container.querySelectorAll("button")].some((item) => /deposit|fund/i.test(item.textContent ?? ""))).toBe(false);
  state.post.mockImplementationOnce(async () => {
    const ready: ExecutionWallet = { ...account, state: "ready", issue: null, address: authorization.accountAddress };
    overview = { ...overview, accounts: [ready] }; return ready;
  });
  await click("Check wallet status");
  expect(state.post.mock.calls[1]).toEqual(["/me/copy/execution-wallets/private-wallet-reference/reconcile", {}]);
  expect(container.textContent).toContain("Ready");
  expect(container.textContent).toContain(authorization.accountAddress);
  expect(container.textContent).not.toContain(account.id);
  expect(container.textContent).not.toContain("Do not send funds");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("prevents duplicate preparation while the initial request is pending", async () => {
  await render(); await selectCopy();
  let complete!: (value: ExecutionWallet) => void;
  state.post.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await click("Prepare dedicated wallet", settleHeld);
  // Busy: the orbit mark, and a second press is refused (Button's loading).
  expect(button("Preparing…").getAttribute("aria-busy")).toBe("true");
  expect(selectTrigger(container)?.disabled).toBe(true);
  await click("Preparing…", settleHeld);
  expect(state.post).toHaveBeenCalledOnce();
  overview = { ...overview, accounts: [account] };
  await act(async () => complete(account)); await settle();
  expect(button("Wallet already prepared").disabled).toBe(true);
});

it("allows retrying copy-list errors without enabling wallet preparation", async () => {
  state.get.mockImplementation(async (path: string) => { if (path === "/me/copy") throw new Error("copies unavailable"); return overview; });
  await render();
  expect(container.textContent).toContain("Could not load your copies.");
  expect(selectTrigger(container)).toBeNull();
  expect(state.post).not.toHaveBeenCalled();
  state.get.mockImplementation(async (path: string) => path === "/me/copy" ? copies : overview);
  await click("Retry");
  expect(selectTrigger(container)).not.toBeNull();
  expect(button("Prepare dedicated wallet").disabled).toBe(true);
});

it("keeps wallet recovery available after a failed status check", async () => {
  overview.accounts = [account]; await render();
  state.post.mockRejectedValueOnce(new Error("unavailable"));
  await click("Check wallet status");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
  expect(button("Check wallet status").disabled).toBe(false);
  expect(container.textContent).toContain("Outcome unconfirmed");
});

it("excludes stopping and stopped copies from preparation but preserves their wallet records", async () => {
  const stoppedCopies = { ...copies, strategies: [
    { ...copies.strategies[0], status: "stopped", id: 9 },
    { ...copies.strategies[0], status: "stopping", id: 10 },
  ] };
  state.get.mockImplementation(async (path: string) => path === "/me/copy" ? stoppedCopies : overview);
  overview.accounts = [account];
  await render();
  expect(selectTrigger(container)).toBeNull();
  expect(container.textContent).toContain("Create a paper copy first");
  expect(container.textContent).toContain("Copy #9");
  expect(button("Check wallet status").disabled).toBe(false);
  expect(state.post).not.toHaveBeenCalled();
});

it("reverifies ready-wallet ownership and keeps blocked wallets terminal", async () => {
  overview.accounts = [{ ...account, state: "ready", address: authorization.accountAddress, issue: null }];
  await render();
  expect(container.textContent).toContain("Ownership is verified only");
  expect(container.textContent).toContain("live trading require separate setup");
  state.post.mockImplementationOnce(async () => {
    const blocked: ExecutionWallet = { ...account, state: "blocked", issue: "wallet_conflict" };
    overview = { ...overview, accounts: [blocked] }; return blocked;
  });
  await click("Reverify wallet ownership");
  expect(state.post).toHaveBeenCalledExactlyOnceWith("/me/copy/execution-wallets/private-wallet-reference/reconcile", {});
  expect(container.textContent).toContain("Blocked");
  expect(container.textContent).toContain("Wallet details conflict");
  expect([...container.querySelectorAll("button")].some((item) => /wallet status|Reverify/.test(item.textContent ?? ""))).toBe(false);
  await selectCopy();
  expect(button("Wallet already prepared").disabled).toBe(true);
});

it("confirms revocation, retries failures, and permanently disables the revoked authorization", async () => {
  overview.authorizations = [authorization]; await render();
  expect(container.textContent).toContain("stops future server signatures only");
  expect(container.textContent).toContain("require cleanup on the exchange");
  expect(container.textContent).toContain(authorization.accountAddress);
  expect(container.textContent).toContain(authorization.signerAddress);
  expect(container.textContent).toContain("Reduce copy positions");
  await click("Revoke authorization");
  expect(state.post).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Revocation cannot be undone");
  state.post.mockRejectedValueOnce(new Error("response lost"));
  await click("Confirm revocation");
  expect(container.textContent).toContain("could not be confirmed");
  expect(button("Confirm revocation").disabled).toBe(false);
  state.post.mockImplementationOnce(async () => {
    const revoked: WalletAuthorization = { ...authorization, status: "revoked", revokedAt: "2026-10-03T00:00:00Z" };
    overview = { ...overview, authorizations: [revoked] }; return revoked;
  });
  await click("Confirm revocation");
  expect(state.post.mock.calls).toEqual([
    ["/me/copy/wallet-authorizations/private-authorization-reference/revoke", {}],
    ["/me/copy/wallet-authorizations/private-authorization-reference/revoke", {}],
  ]);
  expect(button("Revoked permanently").disabled).toBe(true);
  expect(container.textContent).not.toContain(authorization.id);
});

it("uses mainnet from the response and prevents setup while the provider is unavailable", async () => {
  overview.network = "mainnet"; overview.available = false; await render(); await selectCopy();
  expect(container.textContent).toContain("Mainnet");
  expect(container.textContent).toContain("currently unavailable");
  expect(button("Prepare dedicated wallet").disabled).toBe(true);
  expect(state.post).not.toHaveBeenCalled();
  overview = { ...overview, available: true }; await act(async () => { await client.invalidateQueries(); }); await settle();
  state.post.mockImplementationOnce(async () => { const item = { ...account, network: "mainnet" as const }; overview.accounts = [item]; return item; });
  await click("Prepare dedicated wallet");
  expect(state.post).toHaveBeenCalledExactlyOnceWith("/me/copy/strategies/9/execution-wallet", { network: "mainnet" });
});

it("does not call private endpoints while signed out", async () => {
  state.status = "signedOut"; await render();
  expect(state.get).not.toHaveBeenCalled(); expect(state.post).not.toHaveBeenCalled();
});
