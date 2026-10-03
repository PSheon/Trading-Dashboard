import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCopyFunding } from "../src/lib/copy-funding-operation";
import type { CopyFunding, CopyFundingClaim } from "@trading-dashboard/shared/contracts";
const op: CopyFunding = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", accountId: "account", strategyId: 1, network: "testnet", address: `0x${"11".repeat(20)}`, destination: `0x${"22".repeat(20)}`, amount: "10", nonce: 1_770_000_000_000, status: "prepared", canCancel: true, transactionHash: null, fee: null, creditedAmount: null, createdAt: "2026-10-03T08:00:00.000Z", updatedAt: "2026-10-03T08:00:00.000Z" };
const deps = { assertSession: vi.fn(), sign: vi.fn(async () => "signature"), claim: vi.fn(async (): Promise<CopyFundingClaim> => ({ claimed: true, operation: { ...op, status: "unknown" } })), submit: vi.fn(async (): Promise<CopyFunding> => ({ ...op, status: "accepted", canCancel: false })), reconcile: vi.fn(async (): Promise<CopyFunding> => ({ ...op, status: "unknown", canCancel: false })) };
beforeEach(() => { vi.resetAllMocks(); deps.sign.mockResolvedValue("signature"); deps.claim.mockResolvedValue({ claimed: true, operation: { ...op, status: "unknown" } }); deps.submit.mockResolvedValue({ ...op, status: "accepted", canCancel: false }); deps.reconcile.mockResolvedValue({ ...op, status: "unknown", canCancel: false }); });
describe("owner-confirmed strategy funding", () => {
  it("signs the fixed prepared operation and submits only after one claim", async () => {
    expect((await runCopyFunding(op, deps)).status).toBe("accepted");
    expect(deps.sign).toHaveBeenCalledWith(op); expect(deps.claim).toHaveBeenCalledWith(op.id, expect.any(Function));
    expect(deps.submit).toHaveBeenCalledWith(expect.objectContaining({ id: op.id, nonce: op.nonce }), "signature", expect.any(Function));
  });
  it.each(["unknown", "accepted"] as const)("only looks up %s operations, even when a SDK signer exists", async (status) => {
    await runCopyFunding({ ...op, status }, deps);
    expect(deps.reconcile).toHaveBeenCalledOnce(); expect(deps.sign).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled();
  });
  it("does nothing for credited operations", async () => {
    expect(await runCopyFunding({ ...op, status: "credited" }, deps)).toMatchObject({ status: "credited" });
    expect(deps.sign).not.toHaveBeenCalled(); expect(deps.reconcile).not.toHaveBeenCalled();
  });
  it("does not claim when the user rejects signing and keeps the preparation recoverable", async () => {
    deps.sign.mockRejectedValue(new Error("rejected"));
    await expect(runCopyFunding(op, deps)).rejects.toThrow("rejected");
    expect(deps.claim).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled();
  });
  it("does not submit a signature after account switch during signing", async () => {
    deps.sign.mockImplementation(async () => { deps.assertSession.mockImplementation(() => { throw new Error("session changed"); }); return "signature"; });
    await expect(runCopyFunding(op, deps)).rejects.toThrow("session changed");
    expect(deps.claim).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled();
  });
  it("does not submit after session switch while obtaining the claim", async () => {
    deps.claim.mockImplementation(async () => { deps.assertSession.mockImplementation(() => { throw new Error("session changed"); }); return { claimed: true, operation: { ...op, status: "unknown" } }; });
    await expect(runCopyFunding(op, deps)).rejects.toThrow("session changed"); expect(deps.submit).not.toHaveBeenCalled();
  });
  it("never broadcasts after a competing claim or claim response loss", async () => {
    deps.claim.mockResolvedValueOnce({ claimed: false, operation: { ...op, status: "unknown" } });
    expect((await runCopyFunding(op, deps)).status).toBe("unknown"); expect(deps.submit).not.toHaveBeenCalled();
    deps.claim.mockRejectedValueOnce(new Error("lost claim")); await expect(runCopyFunding(op, deps)).rejects.toThrow();
    expect(deps.submit).not.toHaveBeenCalled();
  });
  it.each([{ nonce: op.nonce + 1 }, { amount: "20" }, { accountId: "other" }, { address: op.destination }, { destination: op.address }, { network: "mainnet" }])("refuses altered server intent %j", async (change) => {
    deps.claim.mockResolvedValueOnce({ claimed: true, operation: { ...op, status: "unknown", ...change } as CopyFunding });
    await expect(runCopyFunding(op, deps)).rejects.toThrow("funding_identity_mismatch"); expect(deps.submit).not.toHaveBeenCalled();
  });
  it("preserves an unknown submission without retrying or cancelling", async () => {
    deps.submit.mockRejectedValue(new Error("timeout")); await expect(runCopyFunding(op, deps)).rejects.toThrow();
    expect(deps.submit).toHaveBeenCalledOnce(); expect(deps.reconcile).not.toHaveBeenCalled();
  });
});
it("keeps a stale prepared original reconcile-only after a durable uncertain claim", async () => { const journal = new Set<string>(); deps.claim.mockRejectedValueOnce(new Error('lost')); const guarded = { ...deps, uncertain: (id: string) => journal.has(id), markUncertain: (id: string) => { journal.add(id); } }; await expect(runCopyFunding(op, guarded)).rejects.toThrow('lost'); const signatures = deps.sign.mock.calls.length; await runCopyFunding(op, guarded); expect(deps.sign).toHaveBeenCalledTimes(signatures); expect(deps.reconcile).toHaveBeenCalledOnce(); expect(deps.submit).not.toHaveBeenCalled(); });
it("never claims funds when its uncertainty record cannot persist", async () => { await expect(runCopyFunding(op, { ...deps, markUncertain() { throw new Error('storage_unavailable'); } })).rejects.toThrow('storage_unavailable'); expect(deps.claim).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled(); });
it.each(['0', '-1', '01', '10.0000000', '1e3', '1000000000001'])('rejects invalid or noncanonical original funding amount %s before signing or POST', async amount => { await expect(runCopyFunding({ ...op, amount }, deps)).rejects.toThrow(); expect(deps.sign).not.toHaveBeenCalled(); expect(deps.claim).not.toHaveBeenCalled(); expect(deps.submit).not.toHaveBeenCalled(); });
it.each(['address', 'destination'] as const)('rejects a zero %s before any funding signature', async field => { await expect(runCopyFunding({ ...op, [field]: `0x${'00'.repeat(20)}` }, deps)).rejects.toThrow(); expect(deps.sign).not.toHaveBeenCalled(); expect(deps.claim).not.toHaveBeenCalled(); });
