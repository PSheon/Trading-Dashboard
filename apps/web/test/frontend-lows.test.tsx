// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "../src/i18n/messages/en";
import { clearPersonalStorage } from "../src/lib/personal-storage";

const state = vi.hoisted(() => ({
  identity: null as string | null, replace: vi.fn(), logout: vi.fn(async () => {}),
  del: vi.fn(async () => undefined), post: vi.fn(), me: { isError: false, isPending: false, data: undefined as unknown, error: null as unknown, refetch: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: state.replace, refresh() {}, push() {} }), usePathname: () => "/admin/users" }));
vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ status: "signedIn", mode: "privy", identity: state.identity, logout: state.logout, wallet: null }),
  useMe: () => state.me,
}));
vi.mock("../src/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openExport() {} }) }));
vi.mock("../src/lib/api", async (original) => {
  const actual = await original<typeof import("../src/lib/api")>();
  return { ...actual, api: { ...actual.api, delete: state.del, post: state.post } };
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.identity = null; state.replace.mockReset(); state.logout.mockReset().mockResolvedValue(undefined); state.del.mockReset().mockResolvedValue(undefined); state.post.mockReset();
  state.me = { isError: false, isPending: false, data: undefined, error: null, refetch: vi.fn() };
  sessionStorage.clear(); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const { I18nProvider } = await import("../src/i18n/provider");
const wrap = (node: React.ReactNode, client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })) =>
  <QueryClientProvider client={client}><I18nProvider locale="en" messages={en}>{node}</I18nProvider></QueryClientProvider>;

describe("copy idempotency keys follow the signed-in identity", () => {
  it("does not keep a cold load's ':session' journal once the identity is known", async () => {
    const { useStartCopy } = await import("../src/lib/copy");
    let start!: ReturnType<typeof useStartCopy>;
    function Probe() { start = useStartCopy(); return null; }
    await act(async () => root.render(wrap(<Probe />)));
    state.identity = "alice@example.com";
    await act(async () => root.render(wrap(<Probe />)));
    // An uncertain answer keeps the key for a retry, under its journal.
    state.post.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => { await start.mutateAsync({ leader: `0x${"ab".repeat(20)}`, allocationUsd: 100 }).catch(() => {}); });
    const keys = Object.keys(sessionStorage).filter((key) => key.startsWith("orbie:copy-operations:start"));
    expect(keys).toEqual(["orbie:copy-operations:start:privy:alice@example.com"]);
  });
});

describe("sign-out on a shared device", () => {
  it("removes the referral journals and finished withdrawal metadata, keeping a legacy withdrawal still in doubt", () => {
    localStorage.setItem('orbie.referral.code.v1:["privy","alice@example.com"]', '"ALICE"');
    localStorage.setItem("orbie.referral.capture.v1", "{}");
    localStorage.setItem("orbie:withdrawal:testnet:0xaa", JSON.stringify({ status: "accepted" }));
    localStorage.setItem("orbie:withdrawal:testnet:0xbb", JSON.stringify({ status: "unknown" }));
    localStorage.setItem("locale-hint", "en");
    clearPersonalStorage();
    expect(Object.keys(localStorage).sort()).toEqual(["locale-hint", "orbie:withdrawal:testnet:0xbb"]);
  });
});

describe("account deletion", () => {
  it("reports the deletion even when signing out afterwards fails", async () => {
    const { DeleteAccountDialog } = await import("../src/components/settings/delete-account");
    state.logout.mockRejectedValue(new Error("Privy unavailable"));
    await act(async () => root.render(wrap(<DeleteAccountDialog open onOpenChange={() => {}} />)));
    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => box.click());
    const word = [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.placeholder === "DELETE")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(word, "DELETE");
      word.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = [...document.querySelectorAll("button")].filter((b) => b.textContent?.includes(en.deleteAccount.cta)).at(-1)!;
    await act(async () => confirm.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(state.del).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(en.deleteAccount.failed);
    expect(state.replace).toHaveBeenCalledWith("/en?accountDeleted=1");
  });
});

describe("the admin frame", () => {
  it("offers a retry when /me failed for a passing reason, and says forbidden only for the account's own answer", async () => {
    const { AdminShell } = await import("../src/components/admin/admin-shell");
    state.me = { isError: true, isPending: false, data: undefined, error: Object.assign(new Error("busy"), { status: 503 }), refetch: vi.fn() };
    await act(async () => root.render(wrap(<AdminShell><p>inside</p></AdminShell>)));
    expect(document.body.textContent).toContain(en.common.retry);
    expect(document.body.textContent).not.toContain(en.admin.forbiddenTitle);
    state.me = { ...state.me, error: Object.assign(new Error("no"), { status: 403 }) };
    await act(async () => root.render(wrap(<AdminShell><p>inside</p></AdminShell>)));
    expect(document.body.textContent).toContain(en.admin.forbiddenTitle);
  });
});

describe("the root error page", () => {
  it("renders the default language on the server whatever the cookie says, so hydration matches", async () => {
    document.cookie = "locale=en; path=/";
    const { default: GlobalError } = await import("../src/app/global-error");
    const { DEFAULT_LOCALE } = await import("../src/i18n/config");
    const html = renderToString(<GlobalError error={new Error("x")} retry={() => {}} />);
    expect(html).toContain(`lang="${DEFAULT_LOCALE}"`);
    document.cookie = "locale=; max-age=0; path=/";
  });
});

describe("a session's same-origin fetch", () => {
  it("is cancelled when the account changes, as api requests are", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
    let seen: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => { seen = init?.signal ?? undefined; return new Response("{}"); });
    actual.setAccessTokenGetter(async () => "t", "user-a");
    await actual.fetchAsSession("/trader/0xab/share-image");
    expect(seen?.aborted).toBe(false);
    actual.setAccessTokenGetter(async () => "t", "user-b");
    expect(seen?.aborted).toBe(true);
    fetchSpy.mockRestore();
  });
});
