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
}));
vi.mock("../src/lib/config", () => ({ PRIVY_APP_ID: "test-app" }));
vi.mock("../src/lib/session-queries", () => ({ SessionQueries: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../src/lib/use-wallet-backfill", () => ({ useWalletBackfill() {} }));
vi.mock("../src/lib/use-identity-refetch", () => ({ useIdentityRefetch() {} }));
vi.mock("../src/i18n/provider", () => ({ useI18n: () => ({ locale: "en", setLocale() {} }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
  usePrivy: () => ({ ready: true, authenticated: sdk.authenticated, user: sdk.user, login() {}, logout: async () => {}, getAccessToken: async () => null }),
  useWallets: () => ({ wallets: sdk.wallets, ready: sdk.ready }),
  useExportWallet: () => ({ exportWallet: sdk.exportWallet }),
  useSignTypedData: () => ({ signTypedData: sdk.signTypedData }),
  useSendTransaction: () => ({ sendTransaction: sdk.sendTransaction }),
  useCreateWallet: () => ({ createWallet: sdk.createWallet }),
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
async function render() { await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>)); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sdk.user = { id: "alice", email: undefined, google: { email: "alice@example.com" }, wallet: undefined, linkedAccounts: [] };
  sdk.wallets = []; sdk.ready = true; sdk.authenticated = true;
  vi.clearAllMocks();
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
