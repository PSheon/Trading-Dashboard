import { withdrawalUnits } from '@trading-dashboard/shared/contracts';
import { Dec } from '../common/decimal/dec.js';
import { FUNDING_NONCE_EXPIRY_MS, fundingScanSchema } from './copy-funding-scan.js';
import type { FundingRow } from './copy-funding.repository.js';

type Deposit = Pick<FundingRow, 'status' | 'attemptedAt' | 'nonce' | 'amount' | 'address' | 'destination' | 'scanState'>;
const PENDING: readonly string[] = ['prepared', 'unknown', 'accepted'];
const same = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();

/**
 * The deposit's transfer is in the copy account's own ledger (the info API's
 * userNonFundingLedgerUpdates, checkpointed on the deposit's scan before any
 * explorer read): an internalTransfer from the main wallet to the copy
 * account of exactly the deposit's amount. Not credit evidence (that binds
 * the nonce through the explorer's txDetails and stays the deposit's own
 * confirmation); only that the money arrived, for a setup abort's refund.
 */
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

/**
 * Whether a setup abort's refund may treat its original deposit as settled,
 * proven from the account's own state and never from the explorer:
 * - it is terminal (credited, rejected, cancelled);
 * - its nonce can no longer execute (FUNDING_NONCE_EXPIRY_MS, an hour of
 *   margin included): whatever the account holds now is final for it;
 * - its transfer is in the copy account's ledger (depositOnLedger);
 * - the account's withdrawable balance (read from the account) holds at
 *   least the deposit's amount.
 * Otherwise the money may still be travelling and the refund waits.
 */
export function abortDepositSettled(deposit: Deposit, now: number, withdrawable: string | null): boolean {
  if (!PENDING.includes(deposit.status)) return true;
  // Never sent: the abort cancels it; until then it is not settled.
  if (!deposit.attemptedAt) return false;
  if (Number.isSafeInteger(now) && now >= deposit.nonce + FUNDING_NONCE_EXPIRY_MS) return true;
  if (depositOnLedger(deposit)) return true;
  try { return withdrawable !== null && Dec.from(withdrawable).gte(deposit.amount); } catch { return false; }
}
