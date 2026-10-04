// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WalletHistoryList } from "../src/components/wallet/history-list";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
const state = vi.hoisted(() => ({ status: "unknown", failed: false, historyFailed: false, truncated: false, transfers: [] as object[], open: vi.fn(), retry: vi.fn(), historyRetry: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const DEST = `0x${"22".repeat(20)}`;
vi.mock("../src/lib/wallet", () => ({
  useWalletHistory: () => ({ data: { network: "testnet", address: `0x${"11".repeat(20)}`, transfers: state.transfers, from: '2026-07-06T00:00:00Z', fetchedAt: '2026-10-04T00:00:00Z', truncated: state.truncated }, isError: state.historyFailed, refetch: state.historyRetry }),
  useWithdrawalRecovery: () => ({ data: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce: 1780000000000, updatedAt: '2026-10-04T00:00:00Z', status: state.status, amount: "12.5", destination: `0x${"22".repeat(20)}` }, isError: state.failed, refetch: state.retry }),
}));
vi.mock("../src/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openWithdraw: state.open }) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); state.status = "unknown"; state.failed = false; state.historyFailed = false; state.truncated = false; state.transfers = []; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<I18nProvider locale="en" messages={en}><WalletHistoryList /></I18nProvider>)); }
it("shows pending metadata even when the authoritative ledger is empty", async () => {
  await render();
  expect(container.textContent).toContain(en.wallet.withdrawRecovery);
  expect(container.textContent).toContain(DEST); expect(container.textContent).toContain("12.5 USDC");
  await act(async () => container.querySelector("button")!.click());
  expect(state.open).toHaveBeenCalledTimes(1);
});
it("describes unsigned preparation without presenting it as a completed transfer", async () => {
  state.status = "prepared"; await render();
  expect(container.textContent).toContain(en.wallet.withdrawPrepared);
  expect(container.textContent).not.toContain(en.wallet.withdrawSent);
});
it("retains the accepted operation without claiming bridge arrival or offering resubmission", async () => {
  state.status = "accepted"; await render();
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Withdrawal submission accepted');
  expect(container.textContent).toContain(DEST);
  expect(container.textContent).toContain('1780000000000');
  expect(container.textContent).not.toContain('about 5 minutes');
  expect(container.querySelector("button")).toBeNull();
});
it.each(['rejected', 'cancelled'])('does not show %s as an active or accepted withdrawal', async status => {
  state.status = status; await render();
  expect(container.querySelector('[role="status"]')).toBeNull();
});
it('preserves cached ledger rows while exposing failed refresh and partial coverage', async () => {
  state.status = 'accepted'; state.historyFailed = true; state.truncated = true;
  state.transfers = [{ hash: `0x${'aa'.repeat(32)}`, time: '2026-10-03T00:00:00Z', kind: 'deposit', direction: 'in', amount: 15, token: 'USDC', usd: true }];
  await render();
  expect(container.textContent).toContain('Partial history');
  expect(container.textContent).toContain('Ledger requested');
  expect(container.textContent).toContain('+15 USD');
  await act(async () => container.querySelector('button')!.click());
  expect(state.historyRetry).toHaveBeenCalledOnce();
});
it("exposes a retry when pending-state reads fail, even with ledger data available", async () => {
  state.failed = true; state.status = "accepted"; await render();
  await act(async () => container.querySelector("button")!.click());
  expect(state.retry).toHaveBeenCalledTimes(1);
});
