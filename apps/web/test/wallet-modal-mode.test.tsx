// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WalletModalsProvider, useWalletModals } from "@/components/wallet/wallet-modals";
const state = vi.hoisted(() => ({ mode: "paper", available: true }));
vi.mock("@/lib/site-mode", () => ({ useTradingMode: () => state }));
vi.mock("@/components/wallet/deposit-dialog", () => ({ DepositDialog: ({ open }: { open: boolean }) => open ? <p>actual deposit</p> : null }));
vi.mock("@/components/wallet/withdraw-dialog", () => ({ WithdrawDialog: ({ open }: { open: boolean }) => open ? <p>actual withdrawal</p> : null }));
vi.mock("@/components/wallet/export-key-dialog", () => ({ ExportKeyDialog: () => null }));
function Probe() { const wallet = useWalletModals(); return <><button onClick={wallet.openDeposit}>deposit</button><button onClick={wallet.openWithdraw}>withdraw</button></>; }
let root: Root, host: HTMLDivElement;
async function render() { await act(async () => root.render(<WalletModalsProvider><Probe /></WalletModalsProvider>)); }
beforeEach(async () => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.mode = "paper"; state.available = true; host = document.createElement("div"); root = createRoot(host); await render(); });
afterEach(async () => { await act(async () => root.unmount()); });
it("blocks real deposits and withdrawals in paper and unsupported modes", async () => {
  for (const button of host.querySelectorAll<HTMLButtonElement>("button")) await act(async () => button.click());
  expect(host.textContent).not.toContain("actual");
  state.mode = "testnet"; state.available = false; await render();
  for (const button of host.querySelectorAll<HTMLButtonElement>("button")) await act(async () => button.click());
  expect(host.textContent).not.toContain("actual");
});
it("closes idle financial dialogs on mode changes and does not reopen old intents when switching back", async () => {
  state.mode = "live"; await render(); await act(async () => host.querySelector("button")!.click()); expect(host.textContent).toContain("actual deposit");
  state.mode = "paper"; await render(); expect(host.textContent).not.toContain("actual deposit");
  state.mode = "live"; await render(); expect(host.textContent).not.toContain("actual deposit");
});
