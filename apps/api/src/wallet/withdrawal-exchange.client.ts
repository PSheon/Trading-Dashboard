import { Injectable } from "@nestjs/common";
import { WALLET_NETWORKS, withdraw3Request } from "@trading-dashboard/shared/contracts";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import type { WithdrawalRow } from "./withdrawal.repository.js";

/** One attempt only. Signatures live in request memory and are never logged or persisted. */
@Injectable()
export class WithdrawalExchangeClient {
  constructor(private readonly budget: RequestBudgeterService) {}
  acquire() { return this.budget.acquire(1, "live", 0, { signal: AbortSignal.timeout(10_000) }); }
  async send(operation: WithdrawalRow, signature: string): Promise<unknown> {
    const network = WALLET_NETWORKS[operation.network];
    const response = await fetch(network.exchangeUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withdraw3Request(network, operation.destination, operation.amount, operation.nonce, signature)),
      signal: AbortSignal.timeout(20_000), redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("Withdrawal response unavailable"); }
    return readInfoJson(response, "withdrawal", 64 * 1024);
  }
}
