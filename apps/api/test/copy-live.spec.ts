import { exchangeApprovalFixture } from "./copy-live-test-utils.js";
import { LiveSubmissionBlockedError, type LiveExecutionGate, type LiveExecutionLease } from "../src/copy/live/live-execution-gate.js";
import { describe, expect, it, vi } from "vitest";
import { LiveOrderExecutor, type LiveExecutionJournal, type LiveExecutionRecord, type LiveExchangeTransport } from "../src/copy/live/live-execution.js";
import { buildOrderAction, executionKey, wireDecimal, type LiveOrderIntent } from "../src/copy/live/live-order.js";
import { assertWalletAuthorization, WalletAuthorizationService, type WalletAuthorization } from "../src/copy/live/wallet-authorization.js";

const now = 1_790_000_000_000;
export const grant: WalletAuthorization = { id: "grant", version: 1, userId: 1, strategyId: 2, walletId: "wallet", privyOwnerId: "quorum",
  signerAddress: `0x${"11".repeat(20)}`, accountAddress: `0x${"22".repeat(20)}`, network: "testnet", scopes: ["copy:trade", "copy:reduce"],
  validFrom: now - 1, expiresAt: now + 100_000, revokedAt: null, exchangeApprovedAt: now - 1 };
export const intent: LiveOrderIntent = { authorizationId: "grant", userId: 1, strategyId: 2, walletId: "wallet", network: "testnet",
  accountAddress: grant.accountAddress, reduceOnly: false, cloid: `0x${"ab".repeat(16)}`, asset: 0, side: "B", size: "0.01000", limitPrice: "65000", sizeDecimals: 5, timeInForce: "Ioc" };

/** Test fixture only. Production journal must persist and lock across replicas. */
class Journal implements LiveExecutionJournal {
  rows = new Map<string, LiveExecutionRecord>();
  nonce = now - 1;
  locks = new Map<string, Promise<unknown>>();
  lease: LiveExecutionLease = { assertHeld: async () => {} };
  async withOrderLock<T>(key: string, work: (lease: LiveExecutionLease) => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => work(this.lease));
    this.locks.set(key, next);
    return next;
  }
  async get(key: string) { return this.rows.get(key) ?? null; }
  async prepare(input: Parameters<LiveExecutionJournal["prepare"]>[0]) {
    const existing = this.rows.get(input.key);
    if (existing) return existing;
    const record: LiveExecutionRecord = { key: input.key, fingerprint: input.fingerprint, authorization: input.authorization,
      action: input.action, nonce: this.nonce = Math.max(input.now, this.nonce + 1), expiresAfter: input.now + 60_000,
      state: "prepared", createdAt: input.now, updatedAt: input.now };
    this.rows.set(input.key, record); return record;
  }
  async save(record: LiveExecutionRecord) { this.rows.set(record.key, record); }
}

function setup(gate: LiveExecutionGate = { assertReady: async () => {} }) {
  let current = structuredClone(grant);
  const journal = new Journal();
  const auth = new WalletAuthorizationService({ find: async () => current }, exchangeApprovalFixture(() => now), () => now);
  const transport: LiveExchangeTransport = { network: "testnet",
    sign: vi.fn<LiveExchangeTransport["sign"]>(async (record) => ({ action: record.action, nonce: record.nonce, expiresAfter: record.expiresAfter, signature: { r: "0x01", s: "0x02", v: 27 } })),
    submit: vi.fn<LiveExchangeTransport["submit"]>(async () => ({ state: "filled", exchangeOrderId: "10", filledSize: "0.01", averagePrice: "65000" })),
    query: vi.fn<LiveExchangeTransport["query"]>(async () => null) };
  return { journal, transport, executor: new LiveOrderExecutor(auth, journal, transport, gate, () => now), revoke: () => { current = { ...current, revokedAt: now }; } };
}

describe("live execution authorization and exact wire boundary", () => {
  it("a custom transport cannot execute without a configured exchange approval verifier", async () => {
    const { journal, transport } = setup();
    const auth = new WalletAuthorizationService({ find: async () => grant }, undefined as never, () => now);
    const executor = new LiveOrderExecutor(auth, journal, transport, { assertReady: async () => {} }, () => now);
    await expect(executor.execute(intent)).rejects.toThrow("exchange_approval_verifier_missing");
    expect(transport.sign).not.toHaveBeenCalled(); expect(transport.submit).not.toHaveBeenCalled();
    expect(journal.rows.size).toBe(0);
  });
  it.each([
    { userId: 99 }, { strategyId: 99 }, { walletId: "foreign" }, { network: "mainnet" as const },
    { accountAddress: `0x${"33".repeat(20)}` as const }, { scopes: [] }, { revokedAt: now }, { expiresAt: now },
    { validFrom: now + 1 }, { exchangeApprovedAt: null }, { privyOwnerId: "" },
  ])("denies unsafe authorization %j", (override) => {
    expect(() => assertWalletAuthorization({ ...grant, ...override }, intent, now)).toThrow();
  });
  it("requires reduce permission independently of trade permission", () => {
    expect(() => assertWalletAuthorization({ ...grant, scopes: ["copy:trade"] }, { ...intent, reduceOnly: true }, now)).toThrow("wallet_scope_denied");
  });
  it("preserves exact decimal strings and rejects precision changes", () => {
    expect(buildOrderAction(intent).orders[0]).toMatchObject({ s: "0.01", p: "65000", c: intent.cloid });
    expect(wireDecimal("12345678901234567890.123456789012345678")).toBe("12345678901234567890.123456789012345678");
    for (const size of ["1e-3", "0", "-1", "0.000001", "1.0000000000000000001"]) expect(() => buildOrderAction({ ...intent, size })).toThrow();
    expect(() => buildOrderAction({ ...intent, limitPrice: "65000.1" })).toThrow("price_precision_exceeded");
  });
});

describe("live execution durable submission semantics (injected transport)", () => {
  it("refuses a missing final risk gate before obtaining a signature", async () => {
    const { journal, transport } = setup();
    const auth = new WalletAuthorizationService({ find: async () => grant }, exchangeApprovalFixture(() => now), () => now);
    const executor = new LiveOrderExecutor(auth, journal, transport, undefined as never, () => now);
    await expect(executor.execute(intent)).rejects.toThrow("live_execution_gate_missing");
    expect(transport.sign).not.toHaveBeenCalled();
    expect(transport.submit).not.toHaveBeenCalled();
  });
  it("rechecks controls after signing and refuses a newly paused strategy", async () => {
    let paused = false;
    const { executor, transport, journal } = setup({ assertReady: async () => { if (paused) throw new Error("strategy_paused"); } });
    const sign = vi.mocked(transport.sign).getMockImplementation()!;
    vi.mocked(transport.sign).mockImplementationOnce(async (...args) => {
      const signed = await sign(...args); paused = true; return signed;
    });
    await expect(executor.execute(intent)).rejects.toThrow("strategy_paused");
    expect(transport.submit).not.toHaveBeenCalled();
    expect((await journal.get(executionKey(intent)))?.state).toBe("rejected");
  });
  it("a lease lost during the submitting write cannot POST or rewrite the successor's state", async () => {
    const { executor, journal, transport } = setup();
    let lost = false;
    journal.lease = { assertHeld: async () => { if (lost) throw new Error("execution_lease_lost"); } };
    const save = journal.save.bind(journal);
    vi.spyOn(journal, "save").mockImplementation(async (record) => { await save(record); if (record.state === "submitting") lost = true; });
    await expect(executor.execute(intent)).rejects.toThrow("execution_lease_lost");
    expect(transport.submit).not.toHaveBeenCalled();
    expect((await journal.get(executionKey(intent)))?.state).toBe("submitting");
  });
  it("a missing lease blocks signing", async () => {
    const { executor, journal, transport } = setup();
    journal.lease = undefined as never;
    await expect(executor.execute(intent)).rejects.toThrow("execution_lease_missing");
    expect(transport.sign).not.toHaveBeenCalled();
  });
  it("does not submit when the signer changes the approved size or nonce", async () => {
    for (const change of ["size", "nonce", "expiry"] as const) {
      const { executor, transport } = setup();
      vi.mocked(transport.sign).mockImplementation(async (record) => {
        const action = structuredClone(record.action);
        if (change === "size") action.orders[0].s = "1";
        return { action, nonce: record.nonce + (change === "nonce" ? 1 : 0),
          expiresAfter: record.expiresAfter + (change === "expiry" ? 1 : 0), signature: { r: "0x01", s: "0x02", v: 27 } };
      });
      await expect(executor.execute(intent)).rejects.toThrow("signed_order_payload_mismatch");
      expect(transport.submit).not.toHaveBeenCalled();
    }
  });

  it("serializes duplicate execution and submits once", async () => {
    const { executor, transport } = setup();
    const results = await Promise.all([executor.execute(intent), executor.execute(intent)]);
    expect(results.map((r) => r.state)).toEqual(["filled", "filled"]);
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });
  it("a transport final-gate refusal is definite rejection, not an ambiguous exchange result", async () => {
    const { executor, transport } = setup();
    vi.mocked(transport.submit).mockRejectedValue(new LiveSubmissionBlockedError("risk_changed"));
    const result = await executor.execute(intent);
    expect(result.state).toBe("rejected");
    expect(result.errorCode).toBe("final_execution_check_failed");
  });
  it("never resubmits accepted-then-timeout even when orderStatus has not found the cloid", async () => {
    const { executor, transport } = setup();
    vi.mocked(transport.submit).mockRejectedValue(new Error("accepted but response lost"));
    expect((await executor.execute(intent)).state).toBe("unknown");
    expect((await executor.execute(intent)).state).toBe("unknown");
    expect(transport.query).toHaveBeenCalledTimes(1);
    expect(transport.submit).toHaveBeenCalledTimes(1);
    vi.mocked(transport.query).mockResolvedValue({ state: "filled", exchangeOrderId: "10", filledSize: "0.01" });
    expect((await executor.execute(intent)).state).toBe("filled");
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });
  it("recovers durable submitting after process failure without signing again", async () => {
    const { journal, executor, transport } = setup();
    await executor.execute(intent);
    const key = executionKey(intent);
    const row = (await journal.get(key))!;
    await journal.save({ ...row, state: "submitting", outcome: undefined });
    vi.mocked(transport.query).mockResolvedValue({ state: "resting", exchangeOrderId: "10" });
    expect((await executor.execute(intent)).state).toBe("resting");
    expect(transport.sign).toHaveBeenCalledTimes(1);
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });
  it("a cloid cannot be reused for another payload or strategy", async () => {
    const { executor } = setup();
    await executor.execute(intent);
    await expect(executor.execute({ ...intent, size: "0.02" })).rejects.toThrow("cloid_payload_conflict");
    await expect(executor.execute({ ...intent, strategyId: 3 })).rejects.toThrow("cloid_payload_conflict");
  });
  it("revocation between signing and POST prevents submission", async () => {
    const { executor, transport, revoke } = setup();
    vi.mocked(transport.sign).mockImplementation(async (record) => { revoke(); return { action: record.action, nonce: record.nonce, expiresAfter: record.expiresAfter, signature: { r: "0x01", s: "0x02", v: 27 } }; });
    await expect(executor.execute(intent)).rejects.toThrow("wallet_authorization_revoked");
    expect(transport.submit).not.toHaveBeenCalled();
  });
  it("revocation still allows read-only reconciliation", async () => {
    const { executor, transport, revoke } = setup();
    vi.mocked(transport.submit).mockRejectedValue(new Error("lost"));
    await executor.execute(intent); revoke();
    vi.mocked(transport.query).mockResolvedValue({ state: "cancelled", filledSize: "0" });
    expect((await executor.execute(intent)).state).toBe("cancelled");
  });
  it("persists submitting before POST and leaves it recoverable if final persistence fails", async () => {
    const { journal, executor, transport } = setup();
    vi.mocked(transport.submit).mockImplementation(async () => {
      expect((await journal.get(executionKey(intent)))!.state).toBe("submitting");
      return { state: "filled", exchangeOrderId: "10" };
    });
    const save = journal.save.bind(journal);
    vi.spyOn(journal, "save").mockImplementation(async (record) => { if (record.state === "filled") throw new Error("db failed"); await save(record); });
    await expect(executor.execute(intent)).rejects.toThrow("db failed");
    expect((await journal.get(executionKey(intent)))!.state).toBe("submitting");
  });
  it("definitely pre-submit signing errors remain prepared", async () => {
    const { executor, transport, journal } = setup();
    vi.mocked(transport.sign).mockRejectedValue(new Error("signer unavailable"));
    await expect(executor.execute(intent)).rejects.toThrow("signer unavailable");
    expect((await journal.get(executionKey(intent)))!.state).toBe("prepared");
    expect(transport.submit).not.toHaveBeenCalled();
  });
  it("refuses network mismatch before touching persistence", async () => {
    const { executor, journal } = setup();
    await expect(executor.execute({ ...intent, network: "mainnet" })).rejects.toThrow("transport_network_mismatch");
    expect(journal.rows.size).toBe(0);
  });
});
