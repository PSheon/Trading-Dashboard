// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortfolioView } from "@/components/portfolio-view";
import { I18nProvider } from "@/i18n/provider";
import { zhTW } from "@/i18n/messages/zh-TW";
import { fixtureCopyOverview } from "@/fixtures/copy";

/**
 * Paul, 2026-10-06: the phone portfolio was too noisy. 我的資金 (one total,
 * 主錢包 and 跟單中), compact copy cards that open a detail sheet, 已結束,
 * 最近活動; paper is its own view; no internal ids anywhere.
 */
const OWNER = `0x${"11".repeat(20)}`;
const A = { account: `0xe066${"a".repeat(32)}78da`, mandate: "6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f", leader: `0x${"44".repeat(20)}` };
const B = { account: `0xe50e${"b".repeat(32)}9c01`, mandate: "0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c", leader: `0x${"55".repeat(20)}` };
const C = { account: `0x${"66".repeat(20)}`, mandate: "7a7a7a7a-1111-4222-8333-944444444444", leader: `0x${"77".repeat(20)}` };
const now = new Date().toISOString();
const account = (id: string, strategyId: number, address: string) => ({ id, strategyId, network: "testnet", address, state: "ready", createdAt: now, updatedAt: now });
const mandate = (id: string, accountId: string, strategyId: number, address: string, leader: string) => ({ id, accountId, strategyId, mode: "actual", network: "testnet", accountAddress: address, sourceNetwork: "mainnet",
  leaderAddress: leader, budgetUsd: "100", strategyVersion: 1, state: "active", revision: 7, activationCursor: now, expiresAt: now, createdAt: now, updatedAt: now });
const item = (strategyId: number, x: typeof A, stage: string) => ({ strategyId, leaderAddress: x.leader, sourceNetwork: "mainnet", budgetUsd: "100", status: stage === "stopped" ? "stopped" : "active", stage, createdAt: now,
  accountId: `acct-${strategyId}`, accountAddress: x.account, mandate: stage === "stopped" ? null : { id: x.mandate, state: "active", revision: 7 }, stop: null, pendingTransfer: null, lastRefusal: null, automaticReturn: true,
  sweep: stage === "stopped" ? { amount: "98", status: "credited" } : null });
const items = [item(41, A, "active"), item(42, B, "active"), item(43, C, "stopped")];
const accounts = [account("acct-41", 41, A.account), account("acct-42", 42, B.account), account("acct-43", 43, C.account)];
const mandates = [mandate(A.mandate, "acct-41", 41, A.account, A.leader), mandate(B.mandate, "acct-42", 42, B.account, B.leader)];
const observed = (equity: string) => ({ status: "observed", metrics: { perpEquity: equity, withdrawable: equity, unrealizedPnl: "0" }, positions: [], restingOrders: [] });

const state = vi.hoisted(() => ({ mode: "testnet" as string, deployment: null as unknown }));
/** Orbie's ledger: each copy's 100 USDC deposit (their net deposits). */
const deposit = (strategyId: number, address: string) => ({ id: `funding:${strategyId}`, time: now, kind: "copy_funding", mode: "testnet", amount: 100, strategyId, leaderAddress: null, status: "credited", txHash: null, fee: null, counterparty: address, count: null });
vi.mock("@/lib/funds", async () => ({ ...(await vi.importActual<typeof import("@/lib/funds")>("@/lib/funds")),
  useFundsHistory: () => ({ data: { pages: [{ items: [deposit(41, A.account), deposit(42, B.account)], nextCursor: null }] }, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: async () => undefined }) }));
vi.mock("@/lib/copy-live-setup", async () => ({ ...(await vi.importActual<typeof import("@/lib/copy-live-setup")>("@/lib/copy-live-setup")), useLiveCopyDeployment: () => state.deployment }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "owner", userId: "did:privy:owner", wallet: { address: OWNER } }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/portfolio", useSearchParams: () => new URLSearchParams(window.location.search), useRouter: () => ({ replace() {}, push() {}, refresh() {} }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/site-mode", () => ({ useSiteMode: () => state.mode, useTradingMode: () => ({ mode: state.mode, select: () => false }) }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ data: { totalValue: 500, network: "testnet" } }), signErrorMessage: () => ({ rejected: false, message: "" }) }));
vi.mock("@/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openDeposit() {}, openWithdraw() {}, openExport() {} }) }));
vi.mock("@/lib/copy-live-portfolio", () => {
  const idle = { mutate() {}, mutateAsync: async () => ({}), isPending: false, isError: false, variables: undefined };
  return { onOtherNetwork: (item: { network?: string | null }, network: string | null | undefined) => Boolean(network && item.network && item.network !== network),
    useLiveCopyPortfolio: () => ({ data: { network: "testnet", automaticExecution: true, items }, enabled: true, isError: false }), useLiveCopyPortfolioActions: () => ({ transfer: idle, cancellation: idle, close: idle, cancelTransfer: idle }) };
});
vi.mock("@/lib/copy-execution-wallets", () => ({ useExecutionWallets: () => ({ data: { accounts } }) }));
vi.mock("@/lib/copy-live", () => ({ useLiveCopyOverview: () => ({ data: { mandates, strategies: [] } }) }));
vi.mock("@/lib/copy-follower-snapshot", () => ({ useCopyFollowerSnapshot: (a: { address: string } | null) => ({ data: a ? observed(a.address === A.account ? "112.5" : "95") : undefined, refetch: async () => undefined }) }));
// The stop history holds every copy's stops: B's must never show on A's sheet.
vi.mock("@/lib/copy-live-stop", () => ({
  canResumeLiveCopyStop: () => false,
  useLiveCopyStops: () => ({ enabled: true, history: { data: { items: [{ id: "11111111-1111-4111-8111-111111111111", accountId: "acct-42", mandateId: B.mandate, accountAddress: B.account, strategyId: 42, network: "testnet", originalMandateRevision: 7, revision: 1, state: "requested", trackedExecutionCount: 0, trackingComplete: true, issue: null, flatVerifiedAt: null, createdAt: now, updatedAt: now }], truncated: false } },
    attempts: [], storageError: false, storageReady: true, mutation: { mutateAsync: async () => ({}), isPending: false, isError: false }, discard: { isPending: false, isError: false } }),
}));
vi.mock("@/components/copy/live-copy-actions", () => ({ LiveCopyActions: () => <div>actions</div> }));
vi.mock("@/lib/favorite-groups", () => ({ useTraderCards: () => ({ data: { items: [{ address: A.leader, displayName: "solanadoomer", avatarUrl: null }, { address: B.leader, displayName: "whalehunter", avatarUrl: null }] } }) }));
vi.mock("@/lib/copy", async () => ({
  ...(await vi.importActual<typeof import("@/lib/copy")>("@/lib/copy")),
  useCopyOverview: () => ({ data: fixtureCopyOverview() }), useCopyPortfolio: () => ({ data: undefined }),
  useCopyEvents: () => ({ data: { items: [
    { id: "1", strategyId: 41, type: "order_filled", createdAt: now, payload: { mode: "testnet", coin: "ETH", side: "B", size: "0.5", orderId: "104" } },
    { id: "2", strategyId: 1, type: "order_filled", createdAt: now, payload: { mode: "paper", coin: "HYPE", side: "B", size: "38.5", orderId: "7" } },
  ], hasMore: false }, isPending: false }),
}));
vi.mock("@/components/copy/portfolio-parts", () => ({ PortfolioChart: () => null, PaperSummary: () => <p>PAPER-ACCOUNT</p>, PaperSummarySkeleton: () => null, PortfolioChartSkeleton: () => null, InsightsPanel: () => null, ExposurePanel: () => null, CopySparkline: () => null }));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.mode = "testnet"; state.deployment = { available: true, network: "testnet" }; window.history.replaceState(null, "", "/portfolio");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); document.body.innerHTML = ""; });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={zhTW}><PortfolioView /></I18nProvider></QueryClientProvider>));
}
/** The phone layout (the desktop one renders the same views beside it, hidden by CSS). */
const phone = () => container.querySelector(".md\\:hidden") as HTMLElement;
const cards = () => [...phone().querySelectorAll<HTMLButtonElement>('[data-testid="live-copy-card"]')];

it("我的資金 is one total (main wallet plus the copies), with 主錢包 and 跟單中 under it", async () => {
  await render();
  const funds = phone().querySelector('[data-testid="my-funds"]')!;
  expect(funds.textContent).toContain("$707.50"); // 500 + 112.5 + 95
  expect(funds.textContent).toContain("主錢包"); expect(funds.textContent).toContain("$500.00");
  expect(funds.textContent).toContain("跟單中"); expect(funds.textContent).toContain("$207.50");
});

it("a copy is a two-line card (name and status; PnL and ROI) that opens its detail sheet", async () => {
  await render();
  expect(cards()).toHaveLength(3);
  expect(cards()[0]!.textContent).toContain("solanadoomer"); expect(cards()[0]!.textContent).toContain("跟單中"); expect(cards()[0]!.textContent).toContain("+$12.50");
  expect(phone().textContent).toContain("已結束（1）");
  expect(document.querySelector('[data-testid="live-copy-sheet"]')).toBeNull();
  await act(async () => cards()[0]!.click());
  const sheet = document.querySelector('[data-testid="live-copy-sheet"]')!;
  expect(sheet).toBeTruthy();
  expect(sheet.textContent).toContain("$112.50"); expect(sheet.textContent).toContain("停止跟單");
});

it("renders no internal id: no mandate UUID, 授權版本, full account address or copy number, and no other copy's stop", async () => {
  await render();
  await act(async () => cards()[0]!.click());
  const everything = document.body.textContent!;
  for (const id of [A.mandate, B.mandate, C.mandate, A.account, B.account, C.account]) expect(everything).not.toContain(id);
  expect(everything).not.toContain("授權版本");
  expect(everything).not.toMatch(/#4[123]\b|訂單 #|跟單 #/);
  // A's sheet shows its own short account address only.
  const sheet = document.querySelector('[data-testid="live-copy-sheet"]')!;
  expect(sheet.textContent).toContain("0xe066…78da");
  expect(sheet.textContent).not.toContain("0xe50e");
  // Activity in plain words.
  expect(phone().querySelector('[data-testid="recent-activity"]')!.textContent).toContain("ETH 買入 0.5 · 跟 solanadoomer");
});

it("paper and real money never share a screen: 模擬 is its own view", async () => {
  await render();
  expect(phone().textContent).toContain("我的資金");
  expect(phone().textContent).not.toContain("PAPER-ACCOUNT");
  expect(phone().textContent).not.toContain("HYPE");
  state.mode = "paper";
  await render();
  expect(phone().textContent).toContain("PAPER-ACCOUNT");
  expect(phone().querySelector('[data-testid="my-funds"]')).toBeNull();
  expect(phone().querySelectorAll('[data-testid="live-copy-card"]')).toHaveLength(0);
  expect(phone().textContent).not.toContain("ETH 買入");
});

it("a deployment without real copies (the public paper build) opens on 模擬", async () => {
  state.mode = "paper";
  await render();
  expect(phone().textContent).toContain("PAPER-ACCOUNT");
  expect(phone().querySelector('[data-testid="my-funds"]')).toBeNull();
});

it("a live deployment that has not opened real copies to this user says so on 正式, with no funds card and no 儲值 (audit 2026-10-07 P1-6)", async () => {
  state.mode = "live";
  state.deployment = { network: "mainnet", available: false, inviteOnly: true, sourceNetworks: ["mainnet"], caps: null };
  window.history.replaceState(null, "", "/portfolio?view=real");
  await render();
  expect(phone().querySelector('[data-testid="invite-only"]')!.textContent).toBe("正式跟單尚未開放，目前僅限邀請。");
  expect(phone().querySelector('[data-testid="my-funds"]')).toBeNull();
  expect(phone().textContent).not.toContain("儲值");
  expect(phone().textContent).not.toContain("測試網");
});
