// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** Web audit H5: Privy failing to load or render (a chunk lost to a deploy,
 * PrivyProvider throwing) means a signed-out site, not the global error
 * page; 登入 tries it again. */
const sdk = vi.hoisted(() => ({ throws: true, rendered: 0 }));
vi.mock("../src/lib/config", () => ({ PRIVY_APP_ID: "test-app" }));
vi.mock("../src/lib/session-queries", () => ({ SessionQueries: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../src/lib/use-wallet-backfill", () => ({ useWalletBackfill() {} }));
vi.mock("../src/lib/use-identity-refetch", () => ({ useIdentityRefetch() {} }));
vi.mock("../src/i18n/provider", () => ({ useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => key }), readLocaleCookie: () => null }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("../src/lib/auth-privy", () => ({
  default: function BrokenPrivy() {
    sdk.rendered += 1;
    if (sdk.throws) throw new Error("ChunkLoadError: Loading chunk privy failed");
    return null;
  },
}));

const { AuthProvider, useAuth } = await import("../src/lib/auth");
let auth: ReturnType<typeof useAuth> | undefined;
function Probe() {
  const value = useAuth();
  useEffect(() => { auth = value; }, [value]);
  return <span data-status={value.status}>page</span>;
}
let root: Root, container: HTMLDivElement;
const turns = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); auth = undefined; sdk.throws = true; sdk.rendered = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("a Privy runtime that throws leaves the page up and the visitor signed out, even with a saved session", async () => {
  // A saved session makes Privy load at once (status "loading" until it is ready).
  localStorage.setItem("privy:token", "saved");
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
  await turns();
  expect(sdk.rendered).toBeGreaterThan(0);
  expect(container.textContent).toBe("page");
  expect(auth?.status).toBe("signedOut");
  // 登入 tries the SDK again.
  sdk.throws = false;
  const before = sdk.rendered;
  await act(async () => auth!.login());
  await turns();
  expect(sdk.rendered).toBeGreaterThan(before);
});

it("Privy loaded but never ready (its iframe blocked) signs the visitor out after 10 s instead of holding every request (web audit M6)", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    sdk.throws = false; // renders, never reports ready
    localStorage.setItem("privy:token", "saved");
    await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(auth?.status).toBe("loading");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(auth?.status).toBe("signedOut");
    expect(container.textContent).toBe("page");
  } finally { vi.useRealTimers(); }
});
