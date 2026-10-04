import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';

// A REST charge lasts through its permitted send window (at most 5s)
// plus the provider's 60s accounting window. This never applies to leases.
const MAX_RETRY_AFTER_MS = 65_000;
const safeDelay = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= MAX_RETRY_AFTER_MS;

/** Earliest REST capacity release in the observed snapshot, assuming no
 * intervening charges. It is a retry hint, never a reservation or refund. */
export class HyperliquidRestCapacityError extends LiveBoundaryError {
  constructor(readonly retryAfterMs: number) {
    super('hyperliquid_quota_exhausted');
    if (!safeDelay(retryAfterMs)) throw new LiveBoundaryError('hyperliquid_quota_invalid');
  }
}

/** Accept only the typed, bounded accounting result, not arbitrary error
 * fields or provider data. Existing busy errors keep their normal delay. */
export function sharedRestRetryAfterMs(error: unknown): number | undefined {
  return error instanceof HyperliquidRestCapacityError && safeDelay(error.retryAfterMs)
    ? error.retryAfterMs : undefined;
}
