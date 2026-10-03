import { describe, expect, it, vi } from "vitest";
import type { WalletWithdrawal } from "@trading-dashboard/shared/contracts";
import * as withdrawals from "../src/lib/withdrawal-operation";

const ADDRESS = `0x${"11".repeat(20)}`;
const DEST = `0x${"22".repeat(20)}`;
const operation: WalletWithdrawal = { id: "11111111-1111-4111-8111-111111111111", network: "testnet", address: ADDRESS, destination: DEST, amount: "12.5", nonce: 1780000000000, status: "prepared", createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
function setup() {
  let current = { ...operation };
  const deps = {
    network: "testnet" as const, address: ADDRESS,
    reserve: vi.fn(async () => ({ ...current })),
    claim: vi.fn(async () => { current = { ...current, status: "unknown" }; return { operation: { ...current }, claimed: true }; }),
    cancel: vi.fn(async () => { current = { ...current, status: "cancelled" }; }),
    reconcile: vi.fn(async () => ({ ...current })),
    sign: vi.fn(async () => "test-signature"),
    submit: vi.fn(async (): Promise<WalletWithdrawal> => ({ ...current, status: "accepted" })),
  };
  return { deps, setCurrent: (next: WalletWithdrawal) => { current = next; }, read: () => current };
}
function run(deps: ReturnType<typeof setup>["deps"], operationId?: string) {
  return withdrawals.runDurableWithdrawal({ destination: DEST, amount: "12.500000", operationId }, deps);
}

describe("cross-device withdrawal flow", () => {
  it("signs the reserved immutable payload, claims before submit, and trusts only the server outcome", async () => {
    const { deps, read } = setup();
    deps.submit.mockImplementation(async () => {
      expect(read().status).toBe("unknown");
      return { ...read(), status: "accepted" };
    });
    expect(await run(deps)).toMatchObject({ nonce: 1780000000000, status: "accepted" });
    expect(deps.reserve).toHaveBeenCalledWith({ destination: DEST, amount: "12.5" });
    expect(deps.sign).toHaveBeenCalledWith(operation);
    expect(deps.submit).toHaveBeenCalledWith(expect.objectContaining({ nonce: 1780000000000, status: "unknown" }), "test-signature");
    expect(read().status).toBe("unknown");
  });

  it("never broadcasts if another device already claimed the original operation", async () => {
    const { deps } = setup();
    deps.claim.mockResolvedValue({ operation: { ...operation, status: "unknown" }, claimed: false });
    deps.reconcile.mockResolvedValue({ ...operation, status: "unknown" });
    await expect(run(deps)).rejects.toThrow("withdrawal_unknown");
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("never submits or cancels after the broadcast permission response is lost", async () => {
    const { deps } = setup();
    deps.claim.mockRejectedValue(new Error("response lost"));
    await expect(run(deps)).rejects.toThrow("withdrawal_unknown");
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it("only reconciles an unknown operation without a new signature or submission", async () => {
    const { deps, setCurrent } = setup();
    setCurrent({ ...operation, status: "unknown" });
    await expect(run(deps)).rejects.toThrow("withdrawal_unknown");
    expect(deps.sign).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled();
    deps.reconcile.mockResolvedValue({ ...operation, status: "accepted" });
    expect(await run(deps)).toMatchObject({ id: operation.id, status: "accepted" });
    expect(deps.sign).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled();
  });

  it("uses the pending ID even when another device has already confirmed it, preventing a new withdrawal", async () => {
    const { deps } = setup();
    deps.reconcile.mockResolvedValue({ ...operation, status: "accepted" });
    expect(await run(deps, operation.id)).toMatchObject({ status: "accepted" });
    expect(deps.reserve).not.toHaveBeenCalled(); expect(deps.sign).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled();
  });

  it("cancels unbroadcast preparation if signing is declined", async () => {
    const { deps, read } = setup();
    deps.sign.mockRejectedValue(new Error("User rejected"));
    await expect(run(deps)).rejects.toThrow("User rejected");
    expect(deps.cancel).toHaveBeenCalledWith(operation.id);
    expect(read().status).toBe("cancelled");
    expect(deps.claim).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled();
  });

  it.each(["network", "address", "destination", "amount", "nonce"] as const)("rejects a mismatched %s before submitting", async (field) => {
    const { deps } = setup();
    const changed = { ...operation, [field]: field === "network" ? "mainnet" : field === "nonce" ? operation.nonce + 1 : field === "amount" ? "20" : `0x${"33".repeat(20)}` } as WalletWithdrawal;
    if (field === "nonce") deps.claim.mockResolvedValue({ operation: { ...changed, status: "unknown" }, claimed: true });
    else deps.reserve.mockResolvedValue(changed);
    await expect(run(deps)).rejects.toThrow();
    expect(deps.submit).not.toHaveBeenCalled();
    if (field !== "nonce") expect(deps.sign).not.toHaveBeenCalled();
  });

  it("retains uncertainty after network failure and malformed acknowledgments", async () => {
    for (const failure of [new Error("transport lost"), { status: "ok", response: { type: "order" } } as unknown as WalletWithdrawal]) {
      const { deps, read } = setup();
      if (failure instanceof Error) deps.submit.mockRejectedValue(failure); else deps.submit.mockResolvedValue(failure);
      await expect(run(deps)).rejects.toThrow("withdrawal_unknown");
      expect(read().status).toBe("unknown"); expect(deps.cancel).not.toHaveBeenCalled();
    }
  });

  it("reports a trusted rejection without cancelling an attempted operation", async () => {
    const { deps } = setup();
    deps.submit.mockResolvedValue({ ...operation, status: "rejected" });
    await expect(run(deps)).rejects.toThrow("withdrawal_rejected");
    expect(deps.cancel).not.toHaveBeenCalled();
  });
});

describe("legacy metadata migration", () => {
  const key = withdrawals.withdrawalStorageKey("testnet", ADDRESS);
  const legacy = { destination: DEST, amount: "12.500000", nonce: operation.nonce, status: "unknown" };
  function storage(raw = JSON.stringify(legacy)) {
    let value: string | null = raw;
    return { getItem: vi.fn(() => value), setItem: vi.fn((_key: string, next: string) => { value = next; }), removeItem: vi.fn(() => { value = null; }) };
  }
  it.each(["unknown", "accepted", "prepared"])("preserves the original nonce for a legacy %s operation and sends only metadata", async (status) => {
    const store = storage(JSON.stringify({ ...legacy, status }));
    const importer = vi.fn(async (): Promise<WalletWithdrawal> => ({ ...operation, status: "unknown" }));
    await withdrawals.migrateWithdrawalJournal(store, "testnet", ADDRESS, importer);
    expect(importer).toHaveBeenCalledWith({ destination: DEST, amount: "12.5", nonce: operation.nonce });
    expect(store.removeItem).toHaveBeenCalledWith(key);
  });
  it("retains local metadata if the import response is lost or belongs to another wallet", async () => {
    for (const result of [new Error("offline"), { ...operation, address: DEST, status: "unknown" }]) {
      const store = storage();
      const importer = vi.fn(async (): Promise<WalletWithdrawal> => { if (result instanceof Error) throw result; return result as WalletWithdrawal; });
      await expect(withdrawals.migrateWithdrawalJournal(store, "testnet", ADDRESS, importer)).rejects.toThrow();
      expect(store.removeItem).not.toHaveBeenCalled();
    }
  });
  it("blocks new reservations on corrupt legacy metadata", async () => {
    const importer = vi.fn(); const store = storage("not json");
    await expect(withdrawals.migrateWithdrawalJournal(store, "testnet", ADDRESS, importer)).rejects.toThrow("withdrawal_storage_invalid");
    expect(importer).not.toHaveBeenCalled(); expect(store.removeItem).not.toHaveBeenCalled();
  });
});
