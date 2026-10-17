import { Injectable, Optional } from "@nestjs/common";
import { WALLET_NETWORKS, withdraw3Request } from "@trading-dashboard/shared/contracts";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { reserveLive } from "../hyperliquid/hyperliquid-budget-wait.js";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import type { WithdrawalRow } from "./withdrawal.repository.js";
import { HyperliquidGlobalTransport } from '../hyperliquid/hyperliquid-global-transport.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { jsonDigest } from '../common/crypto/digest.js';

/** Process-local proof (as CopyFundingExchangeClient's): this exact error object, bound to
 * this exact attempt, proves its POST was never handed over. */
const notDispatched = new WeakMap<object, string>();
const attemptDigest = (row: WithdrawalRow) => jsonDigest(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
export function isWithdrawalNotDispatched(error: unknown, attempt: WithdrawalRow): boolean {
  return error instanceof LiveBoundaryError && error.code === 'withdrawal_not_dispatched' && notDispatched.get(error) === attemptDigest(attempt);
}
/** One-use: a failed CAS never becomes authority to reset a later attempt. */
export function consumeWithdrawalNotDispatched(error: unknown, attempt: WithdrawalRow): boolean {
  if (!isWithdrawalNotDispatched(error, attempt)) return false;
  notDispatched.delete(error as object);
  return true;
}

/** One attempt only. Signatures live in request memory and are never logged or persisted. */
@Injectable()
export class WithdrawalExchangeClient {
  constructor(private readonly budget: RequestBudgeterService, @Optional() private readonly global?: HyperliquidGlobalTransport) {}
  acquire() { return reserveLive(this.budget, 1, { maxWaitMs: 10_000 }); }
  /** Throws withdrawal_not_dispatched when the POST was never handed over
   * (quota, proof or permit refused first), withdrawal_submission_unknown
   * once it may have been. */
  async send(rawOperation: WithdrawalRow, signature: string, assertFreshProof?: () => void): Promise<unknown> {
    const operation = Object.freeze(structuredClone(rawOperation));
    let dispatched = false;
    try {
      if (!(this.global instanceof HyperliquidGlobalTransport) || typeof assertFreshProof !== 'function') throw new Error();
      const network = WALLET_NETWORKS[operation.network];
      const request: RequestInit = {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withdraw3Request(network, operation.destination, operation.amount, operation.nonce, signature)),
        signal: AbortSignal.timeout(20_000), redirect: 'error',
      };
      // The withdrawal's charge on the shared meter is its own (`live:withdraw:`).
      const global = this.global;
      const permit = await global.runDefaultOwner('withdraw', () => global.acquireExchange(Date.now() + 5000));
      const response = await permit.dispatch(() => {
        const result: unknown = assertFreshProof();
        if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); throw new Error(); }
        permit.assertFresh();
        request.signal?.throwIfAborted();
        dispatched = true;
        return fetch(network.exchangeUrl, request);
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
      return await readInfoJson(response, 'withdrawal', 64 * 1024);
    } catch {
      if (dispatched) throw new LiveBoundaryError('withdrawal_submission_unknown');
      const error = new LiveBoundaryError('withdrawal_not_dispatched');
      notDispatched.set(error, attemptDigest(operation));
      throw error;
    }
  }
}
