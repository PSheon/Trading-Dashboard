import { expect, it, vi } from 'vitest';
import { AccountRiskExecutionGate } from '../src/copy/live/account-risk-execution-gate.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import { fixture, now } from './copy-live-risk-test-utils.js';
import { assertLiveExecutionReady, assertLiveExecutionPermit, type LiveExecutionPermit } from '../src/copy/live/live-execution-gate.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';

function setup() {
  let clock = now;
  const proof = fixture();
  const record: LiveExecutionRecord = { key: proof.reservations.own.key, fingerprint: proof.reservations.own.fingerprint,
    action: structuredClone(proof.action), market: structuredClone(proof.market), nonce: now, expiresAfter: now + 60000,
    state: 'prepared', createdAt: now, updatedAt: now,
    authorization: { id: 'grant', version: 4, userId: 1, strategyId: 9, walletId: 'agent', privyOwnerId: 'owner',
      accountAddress: proof.intent.accountAddress, signerAddress: `0x${'33'.repeat(20)}`, network: 'testnet',
      scopes: ['copy:trade', 'copy:reduce'], validFrom: now - 1, expiresAt: now + 60000,
      revokedAt: null, exchangeApprovedAt: now - 1 } };
  const assertHeld = vi.fn(), evidence = { proof, assertHeld };
  const read = vi.fn(async () => evidence);
  const gate = new AccountRiskExecutionGate({ read }, () => clock);
  return { proof, record, read, assertHeld, evidence, gate, advance: (milliseconds: number) => { clock += milliseconds; } };
}
it('returns an exact order/phase permit that rechecks its oldest proof after later waits', async () => {
  const s = setup();
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  expect(permit).toMatchObject({ phase: 'sign', key: s.record.key, fingerprint: s.record.fingerprint });
  expect(Object.isFrozen(permit)).toBe(true);
  permit.assertFresh();
  s.advance(5001);
  expect(() => permit.assertFresh()).toThrow('live_risk_stale');
  expect(s.read).toHaveBeenCalledTimes(1);
});
it('uses receipt, policy and collateral evidence rather than an allow-all gate', async () => {
  const s = setup();
  Object.assign(s.proof.accountSource, { quarantined: true });
  await expect(s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record })).rejects.toThrow('live_risk_quarantined');
});
it.each(['version', 'fingerprint', 'action', 'state'] as const)('rejects mismatched persisted %s', async field => {
  const s = setup();
  if (field === 'version') s.record.authorization.version++;
  if (field === 'fingerprint') s.record.fingerprint = 'b'.repeat(64);
  if (field === 'action') s.record.action.orders[0].s = '2';
  if (field === 'state') s.record.state = 'unknown';
  await expect(s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record })).rejects.toThrow('live_risk_record_mismatch');
});
it('detaches provider and caller objects so a later mutation cannot refresh a stale permit', async () => {
  const s = setup(), input = { phase: 'sign' as const, intent: structuredClone(s.proof.intent), record: s.record };
  const permit = await s.gate.assertReady(input);
  Object.assign(s.proof.localSource, { checkedAt: now + 10000 });
  Object.assign(input.record.authorization, { expiresAt: now + 999999 });
  s.advance(5001);
  expect(() => permit.assertFresh()).toThrow('live_risk_stale');
});
it('retains the original serialization lease at the final pure boundary', async () => {
  const s = setup();
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  s.assertHeld.mockImplementation(() => { throw new Error('original_scope_lost'); });
  expect(() => permit.assertFresh()).toThrow('live_risk_serialization_lost');
});
it.each(['live_risk_stale', 'live_risk_serialization_stale'])( 'preserves %s from the original held callback without permitting execution', async code => {
  const s = setup();
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  s.assertHeld.mockImplementation(() => { throw new LiveBoundaryError(code); });
  expect(() => permit.assertFresh()).toThrow(code);
});
it('does not expose arbitrary boundary codes from the serialization callback', async () => {
  const s = setup();
  s.assertHeld.mockImplementation(() => { throw new LiveBoundaryError('private_adapter_detail'); });
  await expect(s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record })).rejects.toThrow('live_risk_serialization_lost');
});
it('rechecks a shorter consent expiry even when all market evidence is fresh', async () => {
  const s = setup(); s.record.authorization.expiresAt = now + 1000;
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  s.advance(1001);
  expect(() => permit.assertFresh()).toThrow('wallet_authorization_expired');
});
it('rejects a missing source and redacts unexpected producer failures', async () => {
  const s = setup();
  const missing = new AccountRiskExecutionGate(undefined as never, () => now);
  await expect(missing.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record })).rejects.toThrow('live_risk_source_unavailable');
  s.read.mockRejectedValue(new Error('sensitive provider detail'));
  await expect(s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record })).rejects.toThrow('live_risk_source_unavailable');
});
it('does not accept a replacement serialization callback after the original scope is lost', async () => {
  const s = setup();
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  s.assertHeld.mockImplementation(() => { throw new Error('original_scope_lost'); });
  s.evidence.assertHeld = vi.fn();
  expect(() => permit.assertFresh()).toThrow('live_risk_serialization_lost');
  expect(s.evidence.assertHeld).not.toHaveBeenCalled();
});
it('allows fresh metadata observations of the same immutable order identity', async () => {
  const s = setup();
  const intent = structuredClone(s.proof.intent);
  intent.market!.observedAt = now - 5001;
  // The source independently resolves this same market now; no action resize.
  const permit = await s.gate.assertReady({ phase: 'sign', intent, record: s.record });
  expect(() => permit.assertFresh()).not.toThrow();
});
it.each(['phase', 'key', 'fingerprint', 'async'] as const)('rejects a substituted or non-synchronous permit: %s', field => {
  const s = setup();
  const permit: LiveExecutionPermit = { phase: 'sign', key: s.record.key, fingerprint: s.record.fingerprint, assertFresh: () => {} };
  if (field === 'phase') Object.assign(permit, { phase: 'submit' });
  if (field === 'key') Object.assign(permit, { key: 'another account' });
  if (field === 'fingerprint') Object.assign(permit, { fingerprint: 'b'.repeat(64) });
  if (field === 'async') permit.assertFresh = async () => {};
  expect(() => assertLiveExecutionPermit(permit, 'sign', s.proof.intent, s.record)).toThrow('live_execution_permit_invalid');
});
it('expires a valid permit when the original journal lease check itself consumes freshness', async () => {
  const s = setup();
  await expect(assertLiveExecutionReady(s.gate, { assertHeld: async () => { s.advance(5001); } }, 'sign', s.proof.intent, s.record))
    .rejects.toThrow('live_risk_stale');
});
it('accepts submit only for the durable submitting record and exact original action', async () => {
  const s = setup();
  await expect(s.gate.assertReady({ phase: 'submit', intent: s.proof.intent, record: s.record })).rejects.toThrow('live_risk_record_mismatch');
  s.record.state = 'submitting';
  const permit = await s.gate.assertReady({ phase: 'submit', intent: s.proof.intent, record: s.record });
  expect(() => assertLiveExecutionPermit(permit, 'submit', s.proof.intent, s.record)).not.toThrow();
});
it('rejects proof that expires during synchronous assessment rather than treating the initial clock as the signing time', async () => {
  const s = setup();
  let calls = 0;
  const gate = new AccountRiskExecutionGate({ read: s.read }, () => ++calls === 1 ? now + 5000 : now + 5001);
  await expect(gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record })).rejects.toThrow('live_risk_stale');
});
it('refuses a clock rollback after the private proof was validated even when its oldest observation is earlier', async () => {
  const s = setup(); s.advance(1000);
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  s.advance(-1);
  expect(() => permit.assertFresh()).toThrow('live_risk_stale');
});
it('continues checking held-reservation expiry after repeated successful boundary checks', async () => {
  const s = setup(); Object.assign(s.proof.reservations.own, { expiresAt: now + 1000 });
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  s.advance(999); permit.assertFresh();
  s.advance(1);
  expect(() => permit.assertFresh()).toThrow('live_risk_reservation');
});
it('continues checking the original signal deadline without refreshing it to the permit clock', async () => {
  const s = setup(); Object.assign(s.proof.signal!, { at: now - 119000 });
  Object.assign(s.proof.policy.limits, { maxSignalAgeSeconds: 120 });
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  s.advance(1000); permit.assertFresh();
  s.advance(1);
  expect(() => permit.assertFresh()).toThrow('stale_signal');
});
it('loads current authority again for a new permit instead of retaining a previous successful assessment', async () => {
  const s = setup();
  const permit = await s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record });
  permit.assertFresh();
  Object.assign(s.proof.accountSource, { quarantined: true });
  await expect(s.gate.assertReady({ phase: 'sign', intent: s.proof.intent, record: s.record })).rejects.toThrow('live_risk_quarantined');
  expect(s.read).toHaveBeenCalledTimes(2);
});
