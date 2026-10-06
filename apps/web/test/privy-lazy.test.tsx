// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ loaded: 0, ready: true, authenticated: false, login: vi.fn() }));
vi.mock("../src/lib/config", () => ({ PRIVY_APP_ID: "test-app" }));
vi.mock("../src/lib/session-queries", () => ({ SessionQueries: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../src/lib/use-wallet-backfill", () => ({ useWalletBackfill() {} }));
vi.mock("../src/lib/use-identity-refetch", () => ({ useIdentityRefetch() {} }));
vi.mock("../src/i18n/provider", () => ({ useI18n: () => ({ locale: "en", setLocale() {} }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
// Counts how often the SDK module itself is evaluated (imported).
vi.mock("@privy-io/react-auth", () => {
  sdk.loaded += 1;
  return {
    PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
    usePrivy: () => ({ ready: sdk.ready, authenticated: sdk.authenticated, user: null, login: sdk.login, logout: async () => {}, getAccessToken: async () => null }),
    useWallets: () => ({ wallets: [], ready: true }),
    useExportWallet: () => ({ exportWallet: vi.fn() }),
    useSignTypedData: () => ({ signTypedData: vi.fn() }),
    useSendTransaction: () => ({ sendTransaction: vi.fn() }),
    useCreateWallet: () => ({ createWallet: vi.fn(async () => ({})) }),
    useUser: () => ({ refreshUser: vi.fn(async () => ({})) }),
  };
});

const { AuthProvider, useAuth } = await import("../src/lib/auth");
type Auth = ReturnType<typeof useAuth>;
let auth: Auth | undefined;
function Probe() {
  const value = useAuth();
  useEffect(() => { auth = value; }, [value]);
  return <span data-status={value.status}>page</span>;
}
let root: Root;
let container: HTMLDivElement;
const turns = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); auth = undefined; sdk.ready = true; sdk.authenticated = false; sdk.login.mockClear();
  // No idle time in these tests unless a test grants it.
  vi.stubGlobal("requestIdleCallback", vi.fn(() => 1));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("renders a public page on the server and at first without the Privy SDK", async () => {
  const html = renderToString(<AuthProvider><Probe /></AuthProvider>);
  expect(html).toContain('data-status="loading"');
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
  await turns(3);
  expect(sdk.loaded).toBe(0);
  // A visitor without a saved session is signed out at once (登入 enabled).
  expect(auth?.status).toBe("signedOut");
  expect(container.textContent).toBe("page");
});

it("loads Privy when the visitor presses 登入 and opens its modal once ready", async () => {
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
  await turns(2);
  await act(async () => auth!.login());
  await turns();
  expect(sdk.loaded).toBe(1);
  expect(sdk.login).toHaveBeenCalledTimes(1);
});

it("loads Privy at once for a saved session or Privy's OAuth callback, and keeps the page mounted", async () => {
  localStorage.setItem("privy:token", "saved");
  sdk.authenticated = true;
  const page = () => container.querySelector("span");
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
  const before = page();
  await turns();
  expect(auth?.status).toBe("signedIn");
  expect(page()).toBe(before); // the same element: Privy arriving does not remount the page
  expect(sdk.login).not.toHaveBeenCalled();
});

it("loads Privy at once for a cookie-mode session (custom auth domain: no token in localStorage)", async () => {
  document.cookie = "privy-session=t; path=/";
  sdk.authenticated = true;
  try {
    await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
    expect(auth?.status).not.toBe("signedOut"); // never a signed-out flash
    await turns();
    expect(sdk.loaded).toBeGreaterThan(0);
    expect(auth?.status).toBe("signedIn");
  } finally { document.cookie = "privy-session=; path=/; max-age=0"; }
});

it("loads Privy at once when its OAuth callback is in the URL (no saved session yet)", async () => {
  history.replaceState(null, "", "/explore?privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=google");
  sdk.authenticated = true;
  try {
    await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
    await turns();
    expect(auth?.status).toBe("signedIn");
  } finally {
    history.replaceState(null, "", "/");
  }
});

it("loads Privy when the browser is idle", async () => {
  let idle: (() => void) | undefined;
  vi.stubGlobal("requestIdleCallback", vi.fn((fn: () => void) => { idle = fn; return 1; }));
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
  await turns(2);
  expect(idle).toBeTypeOf("function");
  await act(async () => idle!());
  await turns();
  expect(auth?.status).toBe("signedOut");
  expect(sdk.loaded).toBe(1);
});
