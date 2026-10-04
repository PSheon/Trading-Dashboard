import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { liveStopCancellationIntentSchema, liveStopCancellationOwnerTypedData, type LiveStopCancellationIntent } from '@trading-dashboard/shared/contracts';
import { liveStopCancellationIntentDigest, verifyLiveStopCancellationConsent } from '../src/copy/copy-live-stop-consent.js';

// Public deterministic test key only; no provider client or configured wallet.
const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const now = 1791000000000;
const intent: LiveStopCancellationIntent = {
  authorizationId: 'stop-authority', stopId: 'stop', accountId: 'account', strategyId: 9, userId: 7,
  network: 'testnet', purpose: 'cancel_tracked_orders', schemaVersion: 1,
  capturedStopRevision: 2, targetDigest: 'a'.repeat(64), accountAddress: `0x${'22'.repeat(20)}`,
  accountRevision: 3, accountWalletId: 'master-wallet', accountOwnerQuorumId: 'owner-quorum',
  ownerPrivyUserId: 'did:privy:owner', ownerAddress: owner.address.toLowerCase(),
  setupId: 'setup', setupRevision: 4, executionWalletId: 'local-agent', agentWalletId: 'agent-wallet',
  agentAddress: `0x${'33'.repeat(20)}`, agentOwnerQuorumId: 'owner-quorum', workerQuorumId: 'worker-quorum',
  grantId: 'grant', grantVersion: 5, grantValidFrom: now - 1000, grantExpiresAt: now + 3600000,
  policyId: 'policy', policyFingerprint: 'b'.repeat(64), nonce: now,
  consentExpiresAt: now + 300000, expiresAt: now + 1800000,
};
const signed = () => owner.signTypedData(liveStopCancellationOwnerTypedData(intent));

describe('signed stop cancellation consent', () => {
  it('accepts the exact owner only during the approval window', async () => {
    const signature = await signed();
    expect(await verifyLiveStopCancellationConsent(intent, signature, now)).toBe(true);
    expect(await verifyLiveStopCancellationConsent(intent, signature, intent.consentExpiresAt - 1)).toBe(true);
    expect(await verifyLiveStopCancellationConsent(intent, signature, now - 1)).toBe(false);
    expect(await verifyLiveStopCancellationConsent(intent, signature, intent.consentExpiresAt)).toBe(false);
    expect(await verifyLiveStopCancellationConsent(intent, signature, intent.expiresAt)).toBe(false);
    expect(await verifyLiveStopCancellationConsent(intent, await other.signTypedData(liveStopCancellationOwnerTypedData(intent)), now)).toBe(false);
  });

  it('cryptographically binds every variable field, including each master and agent identity', async () => {
    const signature = await signed();
    const changes = {
      authorizationId: 'other', stopId: 'other', accountId: 'other', strategyId: 10, userId: 8,
      capturedStopRevision: 3, targetDigest: 'c'.repeat(64), accountAddress: `0x${'44'.repeat(20)}`,
      accountRevision: 4, accountWalletId: 'other', accountOwnerQuorumId: 'other',
      ownerPrivyUserId: 'did:privy:other', ownerAddress: other.address.toLowerCase(),
      setupId: 'other', setupRevision: 5, executionWalletId: 'other', agentWalletId: 'other',
      agentAddress: `0x${'55'.repeat(20)}`, agentOwnerQuorumId: 'other', workerQuorumId: 'other',
      grantId: 'other', grantVersion: 6, grantValidFrom: now - 999, grantExpiresAt: now + 3600001,
      policyId: 'other', policyFingerprint: 'c'.repeat(64), nonce: now + 1,
      consentExpiresAt: now + 299999, expiresAt: now + 1799999,
    } satisfies Omit<LiveStopCancellationIntent, 'network' | 'purpose' | 'schemaVersion'>;
    for (const [field, value] of Object.entries(changes)) {
      const changed = { ...intent, [field]: value };
      expect(liveStopCancellationIntentSchema.safeParse(changed).success, field).toBe(true);
      expect(await verifyLiveStopCancellationConsent(changed, signature, now + 2), field).toBe(false);
      expect(liveStopCancellationIntentDigest(changed), field).not.toBe(liveStopCancellationIntentDigest(intent));
    }
  });

  it('cannot reuse a trading domain, phantom exchange domain, or different primary type', async () => {
    const typed = liveStopCancellationOwnerTypedData(intent);
    for (const domain of [
      { ...typed.domain, name: 'Copy Trading Mandate' },
      { ...typed.domain, name: 'Exchange', chainId: 1337 },
      { ...typed.domain, chainId: 42161 },
      { ...typed.domain, version: '2' },
      { ...typed.domain, verifyingContract: `0x${'66'.repeat(20)}` as `0x${string}` },
    ]) {
      expect(await verifyLiveStopCancellationConsent(intent, await owner.signTypedData({ ...typed, domain }), now)).toBe(false);
    }
    const signature = await owner.signTypedData({ ...typed, primaryType: 'CopyTradingMandate',
      types: { CopyTradingMandate: typed.types.CopyStopCancellation } });
    expect(await verifyLiveStopCancellationConsent(intent, signature, now)).toBe(false);
  });

  it('rejects unsupported scope, unknown fields, invalid identities and excessive lifetimes', async () => {
    const signature = await signed();
    const changes = [
      { network: 'mainnet' }, { purpose: 'cancel_and_close' }, { schemaVersion: 2 },
      { scope: 'copy:reduce' }, { consentSignature: signature }, { userJwt: 'not-a-token' },
      { stopId: '' }, { accountWalletId: 'x'.repeat(129) }, { agentWalletId: 'white space' },
      { userId: 0 }, { strategyId: 2147483648 }, { setupRevision: 0 }, { grantVersion: 1.5 },
      { targetDigest: 'A'.repeat(64) }, { policyFingerprint: 'b'.repeat(63) },
      { accountAddress: intent.ownerAddress }, { agentAddress: intent.accountAddress }, { agentAddress: intent.ownerAddress },
      ...['ownerAddress', 'accountAddress', 'agentAddress'].map(field => ({ [field]: `0x${'00'.repeat(20)}` })),
      { nonce: Number.MAX_SAFE_INTEGER + 1 }, { consentExpiresAt: now }, { consentExpiresAt: now + 300001 },
      { expiresAt: now + 1800001 }, { expiresAt: intent.consentExpiresAt },
      { grantValidFrom: now + 1 }, { grantExpiresAt: intent.expiresAt - 1 },
      { nonce: 8640000000000001, consentExpiresAt: 8640000000000002, expiresAt: 8640000000000003, grantExpiresAt: 8640000000000004 },
    ];
    for (const change of changes) {
      expect(liveStopCancellationIntentSchema.safeParse({ ...intent, ...change }).success, JSON.stringify(change)).toBe(false);
      expect(await verifyLiveStopCancellationConsent({ ...intent, ...change }, signature, now)).toBe(false);
    }
    expect(liveStopCancellationIntentSchema.safeParse({ ...intent, grantExpiresAt: intent.expiresAt }).success).toBe(true);
  });

  it('returns false for malformed or throwing inputs and invalid clocks without leaking exceptions', async () => {
    const signature = await signed();
    const throwing = Object.defineProperty({}, 'stopId', { enumerable: true, get() { throw new Error('untrusted getter'); } });
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    for (const input of [null, undefined, [], 'intent', 1n, Symbol('intent'), throwing, proxy, { ...intent, bad: () => {} }]) {
      await expect(verifyLiveStopCancellationConsent(input, signature, now)).resolves.toBe(false);
    }
    for (const clock of [NaN, Infinity, -Infinity, 0, -1, now + 0.5, Number.MAX_SAFE_INTEGER + 1, 8640000000000001]) {
      await expect(verifyLiveStopCancellationConsent(intent, signature, clock)).resolves.toBe(false);
    }
    for (const signature of [null, undefined, {}, 1n, Symbol('signature'), '0xbad', `0x${'00'.repeat(65)}`]) {
      await expect(verifyLiveStopCancellationConsent(intent, signature, now)).resolves.toBe(false);
    }
  });

  it('detaches the caller intent before asynchronous verification and typed-data signing', async () => {
    const signature = await signed();
    const supplied = structuredClone(intent);
    const verification = verifyLiveStopCancellationConsent(supplied, signature, now);
    supplied.stopId = 'mutated'; supplied.ownerAddress = other.address.toLowerCase();
    expect(await verification).toBe(true);
    const suppliedTyped = structuredClone(intent);
    const typed = liveStopCancellationOwnerTypedData(suppliedTyped);
    suppliedTyped.targetDigest = 'e'.repeat(64);
    expect(await verifyLiveStopCancellationConsent(intent, await owner.signTypedData(typed), now)).toBe(true);
  });

  it('canonicalizes JSONB key order but refuses extra data in the stored intent digest', () => {
    const reordered = Object.fromEntries(Object.entries(intent).reverse());
    expect(liveStopCancellationIntentDigest(reordered)).toBe(liveStopCancellationIntentDigest(intent));
    expect(liveStopCancellationIntentDigest(intent)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => liveStopCancellationIntentDigest({ ...intent, token: 'not-a-token' })).toThrow();
  });
});
