import { describe, expect, it } from "vitest";
import { fundingCreditEvidence } from "../src/copy/copy-funding-evidence.js";

const source = `0x${"11".repeat(20)}`;
const destination = `0x${"22".repeat(20)}`;
const hash = `0x${"aa".repeat(32)}`;
const operation = { network: "testnet" as const, address: source, destination, amount: "12.5", nonce: 1_770_000_000_000 };
const tx = { type: "txDetails", tx: { user: source, hash, error: null, time: operation.nonce + 200,
  action: { type: "usdSend", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination, amount: "12.500000", time: operation.nonce } } };
const ledger = { hash, time: operation.nonce + 200, delta: { type: "internalTransfer", user: source, destination, usdc: "12.5", fee: "0" } };

describe("strategy funding positive receipt evidence", () => {
  it("requires the original signed action and the recipient ledger", () => {
    expect(fundingCreditEvidence(operation, hash, tx, [ledger])).toMatchObject({ transactionHash: hash, creditedAmount: "12.5", fee: "0" });
    expect(fundingCreditEvidence(operation, hash, tx, [])).toBeNull();
    expect(fundingCreditEvidence(operation, hash, null, [ledger])).toBeNull();
  });
  it.each([
    { time: operation.nonce + 1 }, { destination: source }, { amount: "12.500001" },
    { hyperliquidChain: "Mainnet" }, { signatureChainId: "0xa4b1" }, { type: "withdraw3" },
  ])("rejects a similar transfer with altered action %j", (change) => {
    expect(fundingCreditEvidence(operation, hash, { ...tx, tx: { ...tx.tx, action: { ...tx.tx.action, ...change } } }, [ledger])).toBeNull();
  });
  it.each([{ user: destination }, { hash: `0x${"bb".repeat(32)}` }, { error: "failed" }, { error: undefined }])("rejects altered transaction proof %j", (change) => {
    expect(fundingCreditEvidence(operation, hash, { ...tx, tx: { ...tx.tx, ...change } }, [ledger])).toBeNull();
  });
  it.each([{ user: destination }, { destination: source }, { type: "deposit" }, { usdc: "99" }, { fee: "-1" }])("rejects altered receiving ledger %j", (change) => {
    expect(fundingCreditEvidence(operation, hash, tx, [{ ...ledger, delta: { ...ledger.delta, ...change } }])).toBeNull();
  });
  it("does not use a unrelated receipt hash or duplicate contradictory receipts", () => {
    expect(fundingCreditEvidence(operation, `0x${"bb".repeat(32)}`, tx, [ledger])).toBeNull();
    expect(fundingCreditEvidence(operation, hash, tx, [ledger, { ...ledger, delta: { ...ledger.delta, fee: "1" } }])).toBeNull();
  });
  it("deducts a transfer fee exactly, preserving six-decimal amounts", () => {
    const charged = { ...ledger, delta: { ...ledger.delta, fee: "1.000001" } };
    expect(fundingCreditEvidence(operation, hash, tx, [charged])).toMatchObject({ fee: "1.000001", creditedAmount: "11.499999" });
  });
  it("supports a net ledger amount only when net plus fee equals the signed amount", () => {
    expect(fundingCreditEvidence(operation, hash, tx, [{ ...ledger, delta: { ...ledger.delta, usdc: "11.5", fee: "1" } }])).toMatchObject({ creditedAmount: "11.5", fee: "1" });
  });
  it("accepts a valid nonce ahead of ledger time but rejects invalid time or no net credit", () => {
    expect(fundingCreditEvidence(operation, hash, tx, [{ ...ledger, time: operation.nonce - 1000 }])).toMatchObject({ creditedAmount: "12.5" });
    expect(fundingCreditEvidence(operation, hash, tx, [{ ...ledger, time: -1 }])).toBeNull();
    expect(fundingCreditEvidence(operation, hash, tx, [{ ...ledger, delta: { ...ledger.delta, fee: "12.5" } }])).toBeNull();
  });
});
