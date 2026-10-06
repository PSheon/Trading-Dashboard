import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")), api: { get: state.get } }));
vi.mock("@/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openExport() {} }) }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, useRouter: () => ({ push() {} }) }));

const { removeCopySigners } = await import("@/components/settings/delete-account");

beforeEach(() => { vi.clearAllMocks(); });

it("takes Orbie's worker off exactly the copy wallets that have the automatic return, from the owner's browser", async () => {
  state.get.mockResolvedValue({ accounts: [
    { address: `0x${"2a".repeat(20)}`, automaticReturn: true },
    { address: `0x${"2b".repeat(20)}`, automaticReturn: false },
    { address: null, automaticReturn: true },
  ] });
  const wallet = { removeSigners: vi.fn(async () => undefined) };
  await removeCopySigners(wallet);
  expect(state.get).toHaveBeenCalledExactlyOnceWith("/me/copy/execution-wallets");
  expect(wallet.removeSigners).toHaveBeenCalledExactlyOnceWith(`0x${"2a".repeat(20)}`);
});

it("a signer the browser can't remove stops the deletion (the error reaches the dialog)", async () => {
  state.get.mockResolvedValue({ accounts: [{ address: `0x${"2a".repeat(20)}`, automaticReturn: true }] });
  await expect(removeCopySigners({ removeSigners: vi.fn(async () => { throw new Error("copy_wallet_unavailable"); }) })).rejects.toThrow("copy_wallet_unavailable");
});
