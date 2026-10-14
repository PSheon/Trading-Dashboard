import { expect, it } from 'vitest';
import { abortDepositSettled, depositOnLedger } from '../src/copy/copy-live-setup-abort-deposit.js';
import { FUNDING_NONCE_EXPIRY_MS } from '../src/config/constants/timings.js';

const MAIN = `0x${'11'.repeat(20)}`, ACCOUNT = `0x${'22'.repeat(20)}`, HASH = `0x${'aa'.repeat(32)}`, NONCE = 1_760_000_000_000;
const deposit = (changes: object = {}) => ({ status: 'accepted' as const, attemptedAt: new Date(NONCE), nonce: NONCE, amount: '100', address: MAIN, destination: ACCOUNT, scanState: null, ...changes });
const ledger = (delta: Record<string, string | null>) => ({ version: 1, windows: [], receipts: [],
  pendingDetails: [{ hash: HASH, ledger: [{ hash: HASH, time: NONCE + 100, delta: { type: 'internalTransfer', user: MAIN, destination: ACCOUNT, usdc: '100', fee: '0', ...delta } }] }] });

it('the copy account ledger shows the deposit: an internalTransfer from the main wallet of its amount (fee included or not)', () => {
  expect(depositOnLedger(deposit({ scanState: ledger({}) }))).toBe(true);
  expect(depositOnLedger(deposit({ scanState: ledger({ usdc: '99', fee: '1' }) }))).toBe(true);
  expect(depositOnLedger(deposit({ scanState: ledger({ usdc: '50' }) }))).toBe(false);
  expect(depositOnLedger(deposit({ scanState: ledger({ user: ACCOUNT }) }))).toBe(false);
  expect(depositOnLedger(deposit({ scanState: ledger({ destination: MAIN }) }))).toBe(false);
  expect(depositOnLedger(deposit({ scanState: ledger({ type: 'deposit' }) }))).toBe(false);
  expect(depositOnLedger(deposit({ scanState: { version: 1, windows: [], receipts: [] } }))).toBe(false);
  expect(depositOnLedger(deposit({ scanState: { malformed: true } }))).toBe(false);
});

it('a deposit is settled for the refund when terminal, past its nonce window, on the ledger, or held by the balance; never otherwise', () => {
  const now = NONCE + 60_000;
  for (const status of ['credited', 'rejected', 'cancelled'] as const) expect(abortDepositSettled(deposit({ status }), now, null)).toBe(true);
  expect(abortDepositSettled(deposit(), now, null)).toBe(false);
  expect(abortDepositSettled(deposit(), now, '99.999999')).toBe(false);
  expect(abortDepositSettled(deposit(), now, '100')).toBe(true);
  expect(abortDepositSettled(deposit({ status: 'unknown' }), NONCE + FUNDING_NONCE_EXPIRY_MS - 1, '0')).toBe(false);
  expect(abortDepositSettled(deposit({ status: 'unknown' }), NONCE + FUNDING_NONCE_EXPIRY_MS, '0')).toBe(true);
  expect(abortDepositSettled(deposit({ scanState: ledger({}) }), now, '0')).toBe(true);
  // Never sent: the abort cancels it first; it is not settled meanwhile.
  expect(abortDepositSettled(deposit({ status: 'prepared', attemptedAt: null }), NONCE + FUNDING_NONCE_EXPIRY_MS, '100')).toBe(false);
});
