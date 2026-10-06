import { describe, expect, it } from 'vitest';
import { liveStopCancellationIntentSchema, type LiveStopCancellationIntent } from '@trading-dashboard/shared/contracts';
import { liveStopCancellationIntentDigest } from '../src/copy/copy-live-stop-consent.js';

const now = 1791000000000;
const intent: LiveStopCancellationIntent = {
  authorizationId: 'stop-authority', stopId: 'stop', accountId: 'account', strategyId: 9, userId: 7,
  network: 'testnet', purpose: 'cancel_tracked_orders', schemaVersion: 1,
  capturedStopRevision: 2, targetDigest: 'a'.repeat(64), accountAddress: `0x${'22'.repeat(20)}`,
  accountRevision: 3, accountWalletId: 'master-wallet', accountOwnerQuorumId: 'owner-quorum',
  ownerPrivyUserId: 'did:privy:owner', ownerAddress: `0x${'11'.repeat(20)}`,
  setupId: 'setup', setupRevision: 4, executionWalletId: 'local-agent', agentWalletId: 'agent-wallet',
  agentAddress: `0x${'33'.repeat(20)}`, agentOwnerQuorumId: 'owner-quorum', workerQuorumId: 'worker-quorum',
  grantId: 'grant', grantVersion: 5, grantValidFrom: now - 1000, grantExpiresAt: now + 3600000,
  policyId: 'policy', policyFingerprint: 'b'.repeat(64), nonce: now,
  consentExpiresAt: now + 300000, expiresAt: now + 1800000,
};
// A stop's cancellation consents recorded before the one signing model
// (2026-10-07): no new ones are taken, the stopper still honours a stored one.
describe('a stored stop cancellation consent', () => {
  it('its digest covers every variable field', () => {
    const changes = {
      authorizationId: 'other', stopId: 'other', accountId: 'other', strategyId: 10, userId: 8,
      capturedStopRevision: 3, targetDigest: 'c'.repeat(64), accountAddress: `0x${'44'.repeat(20)}`,
      accountRevision: 4, accountWalletId: 'other', accountOwnerQuorumId: 'other',
      ownerPrivyUserId: 'did:privy:other', ownerAddress: `0x${'66'.repeat(20)}`,
      setupId: 'other', setupRevision: 5, executionWalletId: 'other', agentWalletId: 'other',
      agentAddress: `0x${'55'.repeat(20)}`, agentOwnerQuorumId: 'other', workerQuorumId: 'other',
      grantId: 'other', grantVersion: 6, grantValidFrom: now - 999, grantExpiresAt: now + 3600001,
      policyId: 'other', policyFingerprint: 'c'.repeat(64), nonce: now + 1,
      consentExpiresAt: now + 299999, expiresAt: now + 1799999,
    } satisfies Omit<LiveStopCancellationIntent, 'network' | 'purpose' | 'schemaVersion'>;
    for (const [field, value] of Object.entries(changes)) {
      const changed = { ...intent, [field]: value };
      expect(liveStopCancellationIntentSchema.safeParse(changed).success, field).toBe(true);
      expect(liveStopCancellationIntentDigest(changed), field).not.toBe(liveStopCancellationIntentDigest(intent));
    }
  });

  it('canonicalizes JSONB key order but refuses extra data in the stored intent digest', () => {
    const reordered = Object.fromEntries(Object.entries(intent).reverse());
    expect(liveStopCancellationIntentDigest(reordered)).toBe(liveStopCancellationIntentDigest(intent));
    expect(liveStopCancellationIntentDigest(intent)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => liveStopCancellationIntentDigest({ ...intent, token: 'not-a-token' })).toThrow();
  });
});
