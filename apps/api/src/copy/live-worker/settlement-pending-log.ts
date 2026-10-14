import { SETTLEMENT_PENDING_LOG_INTERVAL_MS } from '../../config/constants/timings.js';
import type { LiveSettleOutcome } from './copy-live-settler.js';

/** Logs a `pending` settlement's reason (plus any other outcome fields), at most
 * once per order per SETTLEMENT_PENDING_LOG_INTERVAL_MS. Other outcomes log nothing. */
export class SettlementPendingLog {
  private readonly last = new Map<string, number>();
  constructor(private readonly log: (message: string) => void, private readonly now: () => number = Date.now) {}
  note(key: string, outcome: LiveSettleOutcome): void {
    if (outcome.kind !== 'pending') return;
    const at = this.now(), previous = this.last.get(key);
    if (previous !== undefined && at >= previous && at - previous < SETTLEMENT_PENDING_LOG_INTERVAL_MS) return;
    // Orders not seen for an interval are forgotten (the map stays small).
    if (this.last.size >= 1024) for (const [k, t] of this.last) if (at - t >= SETTLEMENT_PENDING_LOG_INTERVAL_MS) this.last.delete(k);
    this.last.set(key, at);
    const detail = Object.fromEntries(Object.entries(outcome).filter(([field]) => field !== 'kind' && field !== 'reason'));
    this.log(`settlement ${key} pending: ${outcome.reason}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  }
}
