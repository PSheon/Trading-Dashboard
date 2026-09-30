import { describe, expect, it } from "vitest";

import { withdrawProblem } from "@/components/wallet/withdraw-dialog";
import {
  erc20TransferData,
  networkConfig,
  splitSignature,
  usdcString,
  usdcToUnits,
  withdraw3Request,
  withdraw3TypedData,
} from "@/lib/hyperliquid-network";

// The Python SDK's vector (tests/signing_test.py::test_sign_withdraw_from_bridge_action)
// was reproduced by signing this exact typed data with viem: r 0x8363…7cf9, s 0x58b1…3881,
// v 28 (Stage 4 doc, wallet step). These tests pin the payload that produced it.
describe("withdraw3", () => {
  // Testnet already signs with 0x66eee, the chain id the SDK always uses.
  const testnet = networkConfig("testnet");

  it("builds the SDK's EIP-712 payload", () => {
    const typed = withdraw3TypedData(testnet, "0x5E9EE1089755c3435139848e47e6635505d5a13a", "1", 1687816341423);
    expect(typed).toEqual({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: {
        "HyperliquidTransaction:Withdraw": [
          { name: "hyperliquidChain", type: "string" },
          { name: "destination", type: "string" },
          { name: "amount", type: "string" },
          { name: "time", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:Withdraw",
      // Lowercased destination, as the signing docs recommend.
      message: { hyperliquidChain: "Testnet", destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 },
    });
  });

  it("sends the action with nonce = time and a split signature", () => {
    const sig = "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf958b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc8938811c";
    const body = withdraw3Request(testnet, "0x5e9ee1089755c3435139848e47e6635505d5a13a", "1", 1687816341423, sig);
    expect(body.nonce).toBe(body.action.time);
    expect(body.action).toMatchObject({ type: "withdraw3", hyperliquidChain: "Testnet", signatureChainId: "0x66eee" });
    expect(body.signature).toEqual({
      r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
      s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881",
      v: 28,
    });
  });

  it("normalizes v 0/1 to 27/28 and rejects odd lengths", () => {
    expect(splitSignature(`0x${"11".repeat(64)}01`).v).toBe(28);
    expect(() => splitSignature("0x1234")).toThrow();
  });

  it("uses Hyperliquid's chain names per network", () => {
    expect(networkConfig("mainnet").hyperliquidChain).toBe("Mainnet");
    expect(networkConfig("testnet").hyperliquidChain).toBe("Testnet");
  });
});

describe("bridge deposit calldata", () => {
  it("encodes transfer(bridge, units)", () => {
    const bridge = networkConfig("testnet").bridge;
    expect(erc20TransferData(bridge, usdcToUnits("25.5"))).toBe(
      `0xa9059cbb${bridge.slice(2).toLowerCase().padStart(64, "0")}${(25_500_000).toString(16).padStart(64, "0")}`,
    );
    expect(() => erc20TransferData(bridge, BigInt(0))).toThrow();
    expect(() => erc20TransferData("0x123", BigInt(1))).toThrow();
  });

  it("converts USDC amounts exactly", () => {
    expect(usdcToUnits("1")).toBe(BigInt(1_000_000));
    expect(usdcToUnits("0.000001")).toBe(BigInt(1));
    expect(() => usdcToUnits("1.0000001")).toThrow();
    expect(() => usdcToUnits("1e3")).toThrow();
    expect(usdcString(1180.17)).toBe("1180.17");
    expect(usdcString(0.1 + 0.2)).toBe("0.3");
    expect(usdcString(12)).toBe("12");
  });
});

describe("withdraw validation", () => {
  const ok = "0x1111111111111111111111111111111111111111";
  it("is not ready while empty, without shouting", () => {
    expect(withdrawProblem("", "", 100)).toEqual({ ready: false, problem: null });
  });
  it("flags a bad address, the $1 fee floor and the withdrawable ceiling", () => {
    expect(withdrawProblem("0x12", "5", 100).problem).toBe("address");
    expect(withdrawProblem(ok, "1", 100).problem).toBe("belowMin");
    expect(withdrawProblem(ok, "100.01", 100).problem).toBe("overAvailable");
  });
  it("accepts a valid request up to the full balance", () => {
    expect(withdrawProblem(ok, "100", 100)).toEqual({ ready: true, problem: null });
    expect(withdrawProblem(ok, "1.5", 100)).toEqual({ ready: true, problem: null });
  });
});
