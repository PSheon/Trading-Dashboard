// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ReferralSettings,
  ReferralCapture,
  ReferralLanding,
  ReferralRouteCapture,
} from "@/components/settings/referral";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import { LOCALES, type Locale } from "@/i18n/config";
import { flush as flushFor, settleQueries } from "./query-settle";
const state = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  login: vi.fn(),
  status: "signedIn",
  mode: "privy",
  identity: "alice",
  session: "1",
  search: "",
  pathname: "/",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {} }),
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ ...state, wallet: null }) }));
vi.mock("@/lib/api", () => ({
  api: { get: state.get, post: state.post },
  sessionKey: () => state.session,
}));
let root: Root, el: HTMLDivElement, client: QueryClient;
const now = Date.parse("2026-10-04T00:00:00Z");
const overview = {
  code: "ALICE",
  link: "/r/ALICE",
  referred: false,
  bindOpenUntil: new Date(now + 60000).toISOString(),
  hasWallet: false,
  policy: {
    version: "unconfirmed",
    enabled: false,
    rewardBps: null,
    minClaimUnits: null,
    bindWindowSeconds: 86400,
  },
  balances: { earned: "0", available: "0", pending: "0", claimed: "0" },
  canClaim: false,
  claimCapability: {
    enabled: false,
    reason: "collection_and_payout_unavailable",
  },
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(state, {
    status: "signedIn",
    mode: "privy",
    identity: "alice",
    session: "1",
    search: "",
    pathname: "/",
  });
  window.localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(now);
  state.get.mockReset().mockImplementation((path: string) =>
    Promise.resolve(
      path === "/me/referral"
        ? overview
        : path.startsWith("/referral/check/")
          ? { code: "ABC", valid: true }
          : path.includes("/friends")
            ? {
                invited: 1,
                copying: 1,
                items: [
                  {
                    id: "10000000-0000-4000-8000-000000000001",
                    label: "Friend 10000000",
                    joinedAt: new Date(now).toISOString(),
                    copying: true,
                    copyingModes: ["paper", "testnet"],
                  },
                ],
                nextCursor: null,
              }
            : { items: [], nextCursor: null },
    ),
  );
  state.post
    .mockReset()
    .mockResolvedValue({ bound: true, boundAt: new Date(now).toISOString() });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  el.remove();
  vi.restoreAllMocks();
});
// Waits for the referral reads and the automatic bind to answer; flush() is a
// plain wait for the test that holds the prior owner's read open.
const settle = () => settleQueries(client, { ms: 25 });
const flush = () => flushFor(25);
async function render(
  node = <ReferralSettings />,
  locale: Locale = "en",
  wait: () => Promise<void> = settle,
) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider locale={locale} messages={catalogs[locale]}>
          {node}
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
  await wait();
}
it("shows unconfirmed reward terms, precise confirmed balances and disabled payout without implying testnet fees are earned", async () => {
  await render();
  expect(el.textContent).toContain("Reward rate unconfirmed");
  expect(el.textContent).toContain("Paper");
  expect(el.textContent).toContain("Testnet");
  expect(el.textContent).toContain("do not prove collected fees");
  expect(
    [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Claim rewards",
    )?.disabled,
  ).toBe(true);
  expect(state.post).not.toHaveBeenCalled();
  expect(el.textContent).not.toContain("0%");
});
it.each([{ status: "signedOut" }, { status: "disabled" }, { mode: "fixture" }])(
  "hides private referral information and avoids requests under %j",
  async (change) => {
    Object.assign(state, change);
    await render();
    expect(el.querySelector("section")).toBeNull();
    expect(state.get).not.toHaveBeenCalled();
  },
);
it("a held prior-owner response cannot appear after identity switch", async () => {
  let release!: (v: unknown) => void;
  state.get.mockImplementation((path: string) =>
    path === "/me/referral"
      ? new Promise((r) => {
          release = r;
        })
      : Promise.resolve({
          items: [],
          nextCursor: null,
          invited: 0,
          copying: 0,
        }),
  );
  await render(<ReferralSettings />, "en", flush);
  state.identity = "bob";
  state.session = "2";
  state.get.mockResolvedValue({ ...overview, code: "BOB", link: "/r/BOB" });
  await render(<ReferralSettings />, "en", flush);
  await act(async () => release(overview));
  expect(el.textContent).not.toContain("ALICE");
  expect(
    client
      .getQueryCache()
      .getAll()
      .every((q) => !JSON.stringify(q.queryKey).includes("alice")),
  ).toBe(true);
});
it("anonymous route capture checks only the public code and binds once after login", async () => {
  state.status = "signedOut";
  await render(<ReferralLanding code="ABC" />);
  expect(state.get.mock.calls.every(([p]) => p === "/referral/check/ABC")).toBe(
    true,
  );
  expect(state.post).not.toHaveBeenCalled();
  state.status = "signedIn";
  await render(<ReferralLanding code="ABC" />);
  expect(state.post).toHaveBeenCalledWith(
    "/me/referral/bind",
    { code: "ABC" },
    expect.anything(),
  );
  await render(<ReferralCapture />);
  expect(state.post).toHaveBeenCalledOnce();
});
it("invalid route code is never captured or sent", async () => {
  state.status = "signedOut";
  await render(<ReferralLanding code="bad/code" />);
  expect(state.get).not.toHaveBeenCalled();
  expect(state.post).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});
it.each(LOCALES)(
  "translates referral labels and financial caveats in %s",
  async (locale) => {
    await render(<ReferralSettings />, locale);
    expect(el.textContent).not.toContain("referral.");
    expect(
      el.querySelector("section")?.getAttribute("aria-label"),
    ).toBeTruthy();
    if (locale !== "en")
      expect(el.textContent).not.toContain("Reward rate unconfirmed");
  },
);
it("an invalid public code is shown as invalid and never binds after login", async () => {
  state.get.mockImplementation((p: string) =>
    Promise.resolve(
      p.startsWith("/referral/check/")
        ? { code: "ABC", valid: false }
        : overview,
    ),
  );
  await render(<ReferralLanding code="ABC" />);
  expect(el.textContent).toContain("Invitation code unavailable");
  expect(state.post).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});
it("public validation failure offers a read retry without exposing the server error", async () => {
  state.get.mockRejectedValue(new Error("private-server-detail"));
  state.status = "signedOut";
  await render(<ReferralLanding code="ABC" />);
  expect(el.textContent).toContain("Referral information unavailable");
  expect(el.textContent).not.toContain("private-server-detail");
  const retry = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === catalogs.en.common.retry,
  )!;
  expect(retry).toBeTruthy();
  await act(async () => retry.click());
  expect(state.get).toHaveBeenCalledTimes(2);
  expect(state.post).not.toHaveBeenCalled();
});
it("denied durable capture storage offers an error without pretending the invitation was saved or binding", async () => {
  state.status = "signedOut";
  const existing = window.localStorage;
  vi.spyOn(window, "localStorage", "get").mockReturnValue({
    getItem: existing.getItem.bind(existing),
    removeItem: existing.removeItem.bind(existing),
    setItem() {
      throw new Error("storage-denied");
    },
  } as unknown as Storage);
  await render(<ReferralLanding code="ABC" />);
  expect(el.textContent).toContain("Referral information unavailable");
  expect(el.textContent).not.toContain("invitation is saved");
  expect(state.post).not.toHaveBeenCalled();
});
it("an uncertain automatic bind remains visible as original read-only recovery and never resends", async () => {
  state.post.mockRejectedValue(new Error("lost"));
  await render(
    <>
      <ReferralCapture code="ABC" />
      <ReferralSettings />
    </>,
  );
  expect(state.post).toHaveBeenCalledOnce();
  expect(el.textContent).toContain("Original request unconfirmed");
  const original = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "Check original request",
  )!;
  expect(original).toBeTruthy();
  await act(async () => original.click());
  expect(state.post).toHaveBeenCalledOnce();
});
it.each(["signedOut", "disabled"])(
  "clears populated private referral reads on %s transition",
  async (status) => {
    await render();
    expect(el.textContent).toContain("ALICE");
    state.status = status;
    state.session = "retired";
    await render();
    expect(el.querySelector("section")).toBeNull();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  },
);
it("rejects a corrupt money relation without rendering invented zero rewards", async () => {
  const originalGet = state.get.getMockImplementation()!;
  state.get.mockImplementation((p: string) =>
    p === "/me/referral"
      ? Promise.resolve({
          ...overview,
          balances: { ...overview.balances, earned: "1" },
        })
      : originalGet(p),
  );
  await render();
  expect(el.textContent).toContain("Referral information unavailable");
  expect(el.textContent).not.toContain("0 USDC");
  expect(state.post).not.toHaveBeenCalled();
});
it("shows deadlines and referral timestamps using site UTC instead of device-local time", async () => {
  vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue(
    "DEVICE-LOCAL-CLOCK",
  );
  await render();
  expect(el.textContent).not.toContain("DEVICE-LOCAL-CLOCK");
  expect(el.textContent).toContain("UTC");
  expect(el.textContent).toContain("00:01");
});
it("labels an inactive reward policy even when configured terms are present", async () => {
  const get = state.get.getMockImplementation()!;
  state.get.mockImplementation((p: string) =>
    p === "/me/referral"
      ? Promise.resolve({
          ...overview,
          policy: {
            ...overview.policy,
            rewardBps: 500,
            minClaimUnits: "1000000",
          },
        })
      : get(p),
  );
  await render();
  expect(el.textContent).toContain("Reward policy inactive");
  expect(el.textContent).toContain("Reward rate: 5%");
  expect(state.post).not.toHaveBeenCalled();
});
it("captures a referral query introduced by client navigation without remounting global providers", async () => {
  state.status = "signedOut";
  await render(<ReferralRouteCapture />);
  expect(state.get).not.toHaveBeenCalled();
  state.search = "other=kept&ref=abc";
  await render(<ReferralRouteCapture />);
  expect(state.get).toHaveBeenCalledWith("/referral/check/ABC");
  expect(
    JSON.parse(localStorage.getItem("orbie.referral.capture.v1")!).code,
  ).toBe("ABC");
  expect(state.post).not.toHaveBeenCalled();
});
