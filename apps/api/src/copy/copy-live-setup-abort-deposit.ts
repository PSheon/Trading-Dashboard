import { withdrawalUnits } from '@trading-dashboard/shared/contracts';
import { Dec } from '../common/decimal/dec.js';
import { fundingScanSchema } from './copy-funding-scan.js';
import type { FundingRow } from './copy-funding.repository.js';
import { FUNDING_NONCE_EXPIRY_MS } from '../config/constants/timings.js';

type Deposit = Pick<FundingRow, 'status' | 'attemptedAt' | 'nonce' | 'amount' | 'address' | 'destination' | 'scanState'>;
const PENDING: readonly string[] = ['prepared', 'unknown', 'accepted'];
const same = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();

/** The deposit's exact internalTransfer is in the copy account's own ledger (userNonFundingLedgerUpdates,
 * checkpointed on its scan). Not credit evidence (that needs the explorer's txDetails): only that the
 * money arrived, for a setup abort's refund. */
export function depositOnLedger(deposit: Deposit): boolean {
  const scan = fundingScanSchema.safeParse(deposit.scanState);
  if (!scan.success) return false;
  if (scan.data.receipts.length) return true;
  let amount: bigint;
  try { amount = withdrawalUnits(deposit.amount); } catch { return false; }
  return (scan.data.pendingDetails ?? []).some(batch => batch.ledger.some(({ delta }) => {
    if (delta.type !== 'internalTransfer' || !same(delta.user, deposit.address) || !same(delta.destination, deposit.destination) || delta.usdc === null) return false;
    try {
      const usdc = withdrawalUnits(delta.usdc), fee = delta.fee === null ? 0n : withdrawalUnits(delta.fee);
      return usdc === amount || usdc + fee === amount;
    } catch { return false; }
  }));
}

/** Whether a setup abort's refund may treat the deposit as settled, from the account's own state
 * (never the explorer): terminal, its nonce expired (FUNDING_NONCE_EXPIRY_MS), on the ledger
 * (depositOnLedger), or withdrawable covers its amount. Otherwise the refund waits. */
export function abortDepositSettled(deposit: Deposit, now: number, withdrawable: string | null): boolean {
  if (!PENDING.includes(deposit.status)) return true;
  // Never sent: the abort cancels it; until then it is not settled.
  if (!deposit.attemptedAt) return false;
  if (Number.isSafeInteger(now) && now >= deposit.nonce + FUNDING_NONCE_EXPIRY_MS) return true;
  if (depositOnLedger(deposit)) return true;
  try { return withdrawable !== null && Dec.from(withdrawable).gte(deposit.amount); } catch { return false; }
}
