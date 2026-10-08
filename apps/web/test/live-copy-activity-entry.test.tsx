// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CopyExecutionAccount } from "@trading-dashboard/shared/contracts";
import { LiveCopies } from "@/components/copy/live-copies";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import { liveAccount, liveMandate, liveNow } from "./copy-live-fixtures";
import { activityPage } from "./copy-follower-activity-fixtures";
import { settleQueries } from "./query-settle";
const state = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  reason: null as string | null,
  accounts: undefined as CopyExecutionAccount[] | undefined,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    status: "signedIn",
    mode: "privy",
    identity: "owner14",
    wallet: { address: `0x${"11".repeat(20)}` },
  }),
}));
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  api: { get: state.get, post: state.post },
  sessionKey: () => "1",
}));
vi.mock("@/lib/copy-execution-wallets", () => ({
  useExecutionWallets: () => ({
    data: state.accounts ? { accounts: state.accounts } : undefined,
  }),
}));
vi.mock("@/lib/copy-live", () => ({
  useLiveCopyOverview: () => ({
    data: { mandates: [{ ...liveMandate, state: "active" }], strategies: [] },
  }),
}));
vi.mock("@/lib/copy-follower-snapshot", () => ({
  useCopyFollowerSnapshot: () => ({ data: null, refetch: vi.fn() }),
}));
vi.mock("@/components/copy/copy-live-stop", () => ({
  LiveCopyStopAction: () => <div data-testid="stop-action">stop</div>,
}));
vi.mock("@/components/copy/copy-portfolio", () => ({
  useLeaders: () => new Map(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  useSearchParams: () => new URLSearchParams(),
}));
let root: Root, container: HTMLDivElement, client: QueryClient;
const initialViewport = {
  width: window.innerWidth,
  height: window.innerHeight,
};
const reads = () =>
  state.get.mock.calls
    .map(([path]) => path as string)
    .filter((path) => path.includes("/activity?"));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.reason = null;
  state.accounts = [liveAccount];
  state.post.mockReset();
  state.get
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === "/me/copy/live/portfolio"
        ? {
            network: "testnet",
            automaticExecution: true,
            items: [
              {
                network: "testnet",
                strategyId: liveAccount.strategyId,
                accountId: liveAccount.id,
                accountAddress: liveAccount.address,
                leaderAddress: `0x${"44".repeat(20)}`,
                sourceNetwork: "testnet",
                budgetUsd: "100",
                status: "active",
                stage: "active",
                createdAt: new Date(liveNow).toISOString(),
                mandate: { id: liveMandate.id, state: "active", revision: 1 },
                stop: null,
                pendingTransfer: null,
                lastRefusal: state.reason
                  ? {
                      reason: state.reason,
                      at: new Date(liveNow).toISOString(),
                    }
                  : null,
              },
            ],
          }
        : path.startsWith("/me/funds/history")
          ? { items: [], nextCursor: null }
          : path.includes("/activity?")
            ? activityPage()
            : null,
    );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: initialViewport.width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: initialViewport.height,
  });
});
async function render(open = true) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider locale="en" messages={catalogs.en}>
          <LiveCopies />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
  await settleQueries(client, { ms: 20 });
  if (open) {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>("[data-testid=live-copy-card]")!
        .click(),
    );
    await settleQueries(client, { ms: 20 });
  }
}
it("mounts one actual receipt history only in the opened owned-account drawer, after stop and wallet information", async () => {
  state.accounts = [
    liveAccount,
    { ...liveAccount, id: "unselected", strategyId: 99 },
  ];
  await render(false);
  expect(reads()).toEqual([]);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>("[data-testid=live-copy-card]")!
      .click(),
  );
  await settleQueries(client, { ms: 20 });
  const drawer = document.querySelector("[data-testid=live-copy-sheet]")!;
  expect(
    drawer.querySelectorAll('section[aria-label="Actual follower activity"]'),
  ).toHaveLength(1);
  expect(reads()).toEqual([
    `/me/copy/execution-wallets/${liveAccount.id}/activity?limit=10`,
  ]);
  expect(state.post).not.toHaveBeenCalled();
  expect(
    drawer
      .querySelector("[data-testid=stop-action]")!
      .compareDocumentPosition(drawer.querySelector("section")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
      .click(),
  );
  expect(
    document.querySelector('section[aria-label="Actual follower activity"]'),
  ).toBeNull();
});
it.each([
  "missing",
  "loading",
  "strategy",
  "network",
  "address",
  "noAddress",
] as const)(
  "does not mount or query receipt history for %s account data",
  async (kind) => {
    state.accounts =
      kind === "loading"
        ? undefined
        : kind === "missing"
          ? []
          : [
              {
                ...liveAccount,
                ...(kind === "strategy"
                  ? { strategyId: 99 }
                  : kind === "network"
                    ? { network: "mainnet" as const }
                    : kind === "address"
                      ? { address: `0x${"66".repeat(20)}` }
                      : { address: null }),
              },
            ];
    await render();
    expect(
      document.querySelector('section[aria-label="Actual follower activity"]'),
    ).toBeNull();
    expect(reads()).toEqual([]);
    expect(state.post).not.toHaveBeenCalled();
  },
);
it("keeps receipt details touch-sized inside the existing bounded scroll at a narrow height", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 320,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 480,
  });
  await render();
  const activity = document.querySelector(
    'section[aria-label="Actual follower activity"]',
  )!;
  expect(
    activity.querySelector("summary")!.classList.contains("min-h-11"),
  ).toBe(true);
  const drawer = document.querySelector("[role=dialog]")!;
  expect(drawer.classList.contains("max-h-[92dvh]")).toBe(true);
  expect(drawer.querySelector(".overflow-y-auto")!.contains(activity)).toBe(
    true,
  );
  expect(
    drawer
      .querySelector('button[aria-label="Close"]')!
      .classList.contains("size-11"),
  ).toBe(true);
});

it("names an exact already-claimed original trade without claiming it filled", async () => {
  state.reason = "fixed_trade_already_claimed";
  await render();
  expect(
    document.querySelector("[data-testid=live-copy-sheet]")!.textContent,
  ).toContain("This original leader trade already has a copy request.");
  expect(
    document.querySelector("[data-testid=live-copy-sheet]")!.textContent,
  ).not.toContain("another reason");
});
