import { Injectable } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";

/** A dead RPC must not hold the wallet read; the balance is then unknown. */
const RPC_TIMEOUT_MS = 6_000;

interface RpcReply {
  id: number;
  result?: string;
  error?: { message?: string };
}

function hexUnits(value: string | undefined, decimals: number): number {
  if (!value || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error("Invalid RPC balance");
  const units = BigInt(value === "0x" ? "0x0" : value);
  // Balances this app shows fit a double comfortably; keep 6 decimals exact.
  const scale = 10n ** BigInt(decimals);
  return Number(units / scale) + Number(units % scale) / Number(scale);
}

/**
 * Read-only Arbitrum JSON-RPC for the deposit address: USDC not yet bridged
 * and ETH for gas, on the wallet network's chain (HYPERLIQUID_ARBITRUM_RPC_URL).
 * One batched POST, no Hyperliquid weight. Never signs or sends anything.
 */
@Injectable()
export class ArbitrumBalanceClient {
  constructor(private readonly config: AppConfig) {}

  /** @throws on RPC, timeout or shape errors (callers report "unknown"). */
  async balances(address: string, usdcToken: string): Promise<{ usdc: number; eth: number }> {
    const owner = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const body = [
      // balanceOf(address): selector 70a08231
      { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: usdcToken, data: `0x70a08231${owner}` }, "latest"] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: [address, "latest"] },
    ];
    const res = await fetch(this.config.value.hyperliquid.wallet.arbitrumRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Arbitrum RPC failed: ${res.status}`);
    const replies = (await res.json()) as RpcReply[];
    if (!Array.isArray(replies)) throw new Error("Arbitrum RPC: unexpected reply");
    const byId = new Map(replies.map((r) => [r.id, r]));
    const usdc = byId.get(1);
    const eth = byId.get(2);
    if (usdc?.error || eth?.error) throw new Error(`Arbitrum RPC error: ${usdc?.error?.message ?? eth?.error?.message}`);
    return { usdc: hexUnits(usdc?.result, 6), eth: hexUnits(eth?.result, 18) };
  }
}
