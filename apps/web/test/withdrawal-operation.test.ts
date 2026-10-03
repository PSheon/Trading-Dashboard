import { describe, expect, it, vi } from "vitest";
import { createWithdrawalJournal, runWithdrawal, type WithdrawalDependencies } from "@/lib/withdrawal-operation";

function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
  const journal = createWithdrawalJournal(storage, "testnet", `0x${"11".repeat(20)}`);
  const deps: WithdrawalDependencies = { journal, now: () => 123456789, sign: vi.fn(async () => "signature"), submit: vi.fn(async () => ({ status: "ok" as const })), lookup: vi.fn(async () => false) };
  const input = { destination: `0x${"22".repeat(20)}`, amount: "400" };
  return { values, storage, deps, input };
}

describe("withdrawal recovery", () => {
  it("does not sign or resubmit after an ambiguous response, including after reload", async () => {
    const { deps, input, storage } = setup();
    vi.mocked(deps.submit).mockRejectedValueOnce(new Error("connection lost"));
    await expect(runWithdrawal(input, deps)).rejects.toThrow("withdrawal_unknown");
    expect(deps.journal.read()).toMatchObject({ nonce: 123456789, status: "unknown", ...input });
    deps.journal = createWithdrawalJournal(storage, "testnet", `0x${"11".repeat(20)}`);
    await expect(runWithdrawal(input, deps)).rejects.toThrow("withdrawal_unknown");
    expect(deps.sign).toHaveBeenCalledTimes(1);
    expect(deps.submit).toHaveBeenCalledTimes(1);
    vi.mocked(deps.lookup).mockResolvedValueOnce(true);
    await expect(runWithdrawal(input, deps)).resolves.toMatchObject({ status: "accepted", nonce: 123456789 });
  });
  it("blocks a different new request until the unknown original is reconciled", async () => {
    const { deps, input } = setup();
    vi.mocked(deps.submit).mockRejectedValue(new Error("lost"));
    await expect(runWithdrawal(input, deps)).rejects.toThrow();
    await expect(runWithdrawal({ ...input, amount: "20" }, deps)).rejects.toThrow("withdrawal_pending");
    expect(deps.sign).toHaveBeenCalledTimes(1);
  });
  it("retains an uncertain operation when the status lookup fails", async () => {
    const { deps, input } = setup();
    vi.mocked(deps.submit).mockRejectedValue(new Error("lost"));
    await expect(runWithdrawal(input, deps)).rejects.toThrow();
    vi.mocked(deps.lookup).mockRejectedValue(new Error("upstream unavailable"));
    await expect(runWithdrawal(input, deps)).rejects.toThrow("upstream unavailable");
    expect(deps.journal.read()?.status).toBe("unknown");
  });
  it("does not broadcast if durable storage fails", async () => {
    const { deps, input } = setup();
    deps.journal.write = () => { throw new Error("storage unavailable"); };
    await expect(runWithdrawal(input, deps)).rejects.toThrow("storage unavailable");
    expect(deps.submit).not.toHaveBeenCalled();
  });
  it("clears a rejected signature because no request has been broadcast", async () => {
    const { deps, input } = setup();
    vi.mocked(deps.sign).mockRejectedValue(new Error("User rejected"));
    await expect(runWithdrawal(input, deps)).rejects.toThrow("User rejected");
    expect(deps.journal.read()).toBeNull();
    expect(deps.submit).not.toHaveBeenCalled();
  });
  it("never persists signatures", async () => {
    const { deps, input, values } = setup();
    await runWithdrawal(input, deps);
    expect([...values.values()].join()).not.toContain("signature");
  });
  it("fails closed on damaged storage instead of silently creating a new intent", () => {
    const { deps, values } = setup();
    deps.journal.write({ ...setup().input, nonce: 123456789, status: "unknown" });
    for (const k of values.keys()) values.set(k, "broken");
    expect(() => deps.journal.read()).toThrow("withdrawal_storage_invalid");
  });
});
