// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth, type AuthState } from "../src/lib/auth";

const sdk = vi.hoisted(() => ({
  user: { id: "alice", email: undefined, google: { email: "alice@example.com" }, wallet: undefined, linkedAccounts: [] as object[] },
  wallets: [] as object[], ready: true, authenticated: true,
  exportWallet: vi.fn(async () => {}),
  signTypedData: vi.fn(async () => ({ signature: "0x1234" })),
  sendTransaction: vi.fn(async () => ({ hash: "0x5678" })),
  createWallet: vi.fn(async () => ({})),
  refreshUser: vi.fn(async () => ({})),
  addSigners: vi.fn(async () => ({ user: {} })),
  removeSigners: vi.fn(async () => ({ user: {} })),
}));
vi.mock("../src/lib/config", () => ({ PRIVY_APP_ID: "test-app" }));
vi.mock("../src/lib/session-queries", () => ({ SessionQueries: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../src/lib/use-wallet-backfill", () => ({ useWalletBackfill() {} }));
vi.mock("../src/lib/use-identity-refetch", () => ({ useIdentityRefetch() {} }));
vi.mock("../src/i18n/provider", () => ({ useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => key }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
  usePrivy: () => ({ ready: true, authenticated: sdk.authenticated, user: sdk.user, login() {}, logout: async () => {}, getAccessToken: async () => null }),
  useWallets: () => ({ wallets: sdk.wallets, ready: sdk.ready }),
  useExportWallet: () => ({ exportWallet: sdk.exportWallet }),
  useSignTypedData: () => ({ signTypedData: sdk.signTypedData }),
  useSendTransaction: () => ({ sendTransaction: sdk.sendTransaction }),
  useCreateWallet: () => ({ createWallet: sdk.createWallet }),
  useUser: () => ({ refreshUser: sdk.refreshUser }),
  useSigners: () => ({ addSigners: sdk.addSigners, removeSigners: sdk.removeSigners }),
}));

const MAIN = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const account = (address: string, walletIndex: number | null = 0, client = "privy") => ({ type: "wallet", address, chainType: "ethereum", walletClientType: client, walletIndex, imported: false, delegated: false });
const typedData = { domain: { name: "test", version: "1", chainId: 42161, verifyingContract: MAIN as `0x${string}` }, types: {}, primaryType: "Test", message: {} };
let root: Root;
let container: HTMLDivElement;
let auth: AuthState;
function Probe() {
  const value = useAuth();
  useEffect(() => { auth = value; }, [value]);
  return <span>{value.wallet?.address}</span>;
}
// Privy loads lazily (lib/auth-privy.tsx): at once with a saved session.
async function render() {
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
  // React applies the lazy module's arrival when an act() ends: poll in turns.
  for (let i = 0; i < 200 && (!auth || auth.status === "loading"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sdk.user = { id: "alice", email: undefined, google: { email: "alice@example.com" }, wallet: undefined, linkedAccounts: [] };
  sdk.wallets = []; sdk.ready = true; sdk.authenticated = true;
  vi.clearAllMocks();
  localStorage.setItem("privy:token", "saved");
  auth = undefined as unknown as AuthState;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("Privy main account identity", () => {
  it("uses HD index zero for signing and export when another wallet is listed first", async () => {
    sdk.user.linkedAccounts = [account(OTHER, 1), account(MAIN)];
    sdk.wallets = [account(OTHER, 1), account(MAIN)];
    await render();
    expect(container.textContent).toBe(MAIN);
    await auth.wallet!.exportKey();
    await auth.wallet!.signTypedData(typedData);
    await auth.wallet!.sendTransaction({ to: MAIN, data: "0x", chainId: 42161 }, false);
    expect(sdk.exportWallet).toHaveBeenCalledWith({ address: MAIN });
    expect(sdk.signTypedData).toHaveBeenCalledWith(typedData, { address: MAIN });
    expect(sdk.sendTransaction).toHaveBeenCalledWith({ to: MAIN, data: "0x", chainId: 42161 }, { sponsor: false, address: MAIN });
  });

  it("exports a copy wallet by its own address through Privy, and refuses a malformed address or a retained signer", async () => {
    sdk.user.linkedAccounts = [account(MAIN)];
    sdk.wallets = [account(MAIN)];
    await render();
    const copy = "0x" + "3c".repeat(20);
    await auth.wallet!.exportCopyKey(copy.toUpperCase().replace("0X", "0x"));
    expect(sdk.exportWallet).toHaveBeenCalledWith({ address: copy });
    await expect(auth.wallet!.exportCopyKey("not-an-address")).rejects.toThrow();
    const old = auth.wallet!;
    sdk.user = { ...sdk.user, id: "bob", linkedAccounts: [account(OTHER)] };
    sdk.wallets = [account(OTHER)];
    await render();
    await expect(old.exportCopyKey(copy)).rejects.toThrow();
    expect(sdk.exportWallet).toHaveBeenCalledTimes(1);
  });

  it("never signs as a copy wallet: the worker signs every copy-account action under the owner's policy (one signing model)", async () => {
    const copy = "0x" + "3c".repeat(20);
    sdk.user.linkedAccounts = [account(MAIN), account(copy, null)];
    sdk.wallets = [account(MAIN), account(copy, null)];
    await render();
    expect(auth.wallet).not.toHaveProperty("signAsAccount");
    expect(Object.keys(auth.wallet!).sort()).toEqual(["addSigners", "address", "exportCopyKey", "exportKey", "removeSigners", "sendTransaction", "signTypedData"]);
  });

  it("adds and removes signers only on one of the user's own copy wallets", async () => {
    const copy = "0x" + "3c".repeat(20);
    sdk.user.linkedAccounts = [account(MAIN), account(copy, null)];
    sdk.wallets = [account(MAIN), account(copy, null)];
    await render();
    const signers = [{ signerId: "worker-quorum", policyIds: ["policy-1"] }];
    await auth.wallet!.addSigners(copy, signers);
    expect(sdk.addSigners).toHaveBeenCalledExactlyOnceWith({ address: copy, signers });
    await auth.wallet!.removeSigners(copy);
    expect(sdk.removeSigners).toHaveBeenCalledExactlyOnceWith({ address: copy });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const refused = expect(auth.wallet!.addSigners(MAIN, signers)).rejects.toThrow("copy_wallet_unavailable");
      await vi.runAllTimersAsync(); await refused;
    } finally { vi.useRealTimers(); }
    expect(sdk.addSigners).toHaveBeenCalledTimes(1);
  });

  it("recognizes a Privy v2 main account", async () => {
    sdk.user.linkedAccounts = [account(MAIN, 0, "privy-v2")];
    sdk.wallets = [account(MAIN, 0, "privy-v2")];
    await render();
    expect(container.textContent).toBe(MAIN);
  });

  it.each([
    { name: "only a secondary HD wallet", linked: [account(OTHER, 1)], connected: [account(OTHER, 1)], ready: true },
    { name: "multiple index-zero wallets", linked: [account(MAIN), account(OTHER)], connected: [account(MAIN), account(OTHER)], ready: true },
    { name: "a connected wallet absent from the current user's profile", linked: [], connected: [account(MAIN)], ready: true },
    { name: "wallet SDK still initializing", linked: [account(MAIN)], connected: [account(MAIN)], ready: false },
  ])("blocks financial actions with $name", async ({ linked, connected, ready }) => {
    sdk.user.linkedAccounts = linked; sdk.wallets = connected; sdk.ready = ready;
    await render();
    expect(auth.wallet?.address).toBeNull();
    await expect(auth.wallet!.exportKey()).rejects.toThrow();
    await expect(auth.wallet!.signTypedData(typedData)).rejects.toThrow();
    await expect(auth.wallet!.sendTransaction({ to: MAIN, data: "0x", chainId: 42161 }, false)).rejects.toThrow();
    expect(sdk.exportWallet).not.toHaveBeenCalled();
    expect(sdk.signTypedData).not.toHaveBeenCalled();
    expect(sdk.sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects a retained signer after changing users", async () => {
    sdk.user.linkedAccounts = [account(MAIN)]; sdk.wallets = [account(MAIN)];
    await render();
    const oldSigner = auth.wallet!;
    sdk.user = { ...sdk.user, id: "bob", google: { email: "bob@example.com" }, linkedAccounts: [account(OTHER)] };
    sdk.wallets = [account(OTHER)]; await render();
    await expect(oldSigner.exportKey()).rejects.toThrow();
    await expect(oldSigner.signTypedData(typedData)).rejects.toThrow();
    await expect(oldSigner.sendTransaction({ to: MAIN, data: "0x", chainId: 42161 }, true)).rejects.toThrow();
    expect(sdk.exportWallet).not.toHaveBeenCalled();
    expect(sdk.signTypedData).not.toHaveBeenCalled();
    expect(sdk.sendTransaction).not.toHaveBeenCalled();
  });

  it("attempts missing-wallet creation once per user rather than once per page lifetime", async () => {
    await render(); await render();
    expect(sdk.createWallet).toHaveBeenCalledTimes(1);
    sdk.user = { ...sdk.user, id: "bob", google: { email: "bob@example.com" } };
    await render();
    expect(sdk.createWallet).toHaveBeenCalledTimes(2);
  });

  it("shows the Google identity while the API profile is loading", async () => {
    await render();
    expect(auth.identity).toBe("alice@example.com");
  });
});
