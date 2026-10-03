import { Injectable } from "@nestjs/common";
import { WALLET_NETWORKS, usdSendRequest, withdrawalUnits } from "@trading-dashboard/shared/contracts";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import type { FundingRow } from "./copy-funding.repository.js";

@Injectable()
export class CopyFundingExchangeClient {
  constructor(private readonly budget: RequestBudgeterService) {}
  acquire() { return this.budget.acquire(1, "live", 0, { signal: AbortSignal.timeout(10_000) }); }
  private async read(url: string, body: Record<string, unknown>, weight: number): Promise<unknown> {
    await this.budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(10_000) });
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("Funding evidence unavailable"); }
    return readInfoJson(response, "copy funding evidence", 1024 * 1024);
  }
  async available(operation: FundingRow): Promise<boolean> {
    const value = await this.read(WALLET_NETWORKS[operation.network].infoUrl, { type: "clearinghouseState", user: operation.address }, 2);
    if (!value || typeof value !== "object" || !("withdrawable" in value) || typeof value.withdrawable !== "string") throw new Error("Funding balance unavailable");
    return withdrawalUnits(value.withdrawable) >= withdrawalUnits(operation.amount);
  }
  async send(operation: FundingRow, signature: string): Promise<unknown> {
    const response = await fetch(WALLET_NETWORKS[operation.network].exchangeUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(usdSendRequest(WALLET_NETWORKS[operation.network], operation.destination, operation.amount, operation.nonce, signature)),
      redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("Funding submission unavailable"); }
    return readInfoJson(response, "copy funding", 64 * 1024);
  }
  txDetails(network: FundingRow["network"], hash: string) {
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid funding evidence");
    const url = network === "mainnet" ? "https://rpc.hyperliquid.xyz/explorer" : "https://rpc.hyperliquid-testnet.xyz/explorer";
    return this.read(url, { type: "txDetails", hash }, 40);
  }
}
