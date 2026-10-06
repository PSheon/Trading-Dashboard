import { Injectable, Optional } from "@nestjs/common";
import { WALLET_NETWORKS, withdraw3Request } from "@trading-dashboard/shared/contracts";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { reserveLive } from "../hyperliquid/hyperliquid-budget-wait.js";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import type { WithdrawalRow } from "./withdrawal.repository.js";
import { HyperliquidGlobalTransport } from '../hyperliquid/hyperliquid-global-transport.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';

/** One attempt only. Signatures live in request memory and are never logged or persisted. */
@Injectable()
export class WithdrawalExchangeClient {
  constructor(private readonly budget: RequestBudgeterService, @Optional() private readonly global?: HyperliquidGlobalTransport) {}
  acquire() { return reserveLive(this.budget, 1, { maxWaitMs: 10_000 }); }
  async send(rawOperation: WithdrawalRow, signature: string, assertFreshProof?: () => void): Promise<unknown> {
    try {
      if (!(this.global instanceof HyperliquidGlobalTransport) || typeof assertFreshProof !== 'function') throw new Error();
      const operation = Object.freeze(structuredClone(rawOperation));
      const network = WALLET_NETWORKS[operation.network];
      const request: RequestInit = {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withdraw3Request(network, operation.destination, operation.amount, operation.nonce, signature)),
        signal: AbortSignal.timeout(20_000), redirect: 'error',
      };
      const permit = await this.global.currentQuota().acquireRest(1, Date.now() + 5000);
      const response = await permit.dispatch(() => {
        const result: unknown = assertFreshProof();
        if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); throw new Error(); }
        permit.assertFresh();
        request.signal?.throwIfAborted();
        return fetch(network.exchangeUrl, request);
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
      return await readInfoJson(response, 'withdrawal', 64 * 1024);
    } catch { throw new LiveBoundaryError('withdrawal_submission_unknown'); }
  }
}
