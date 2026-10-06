import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { liveCopyMandateOwnerTypedData, liveCopyMandateIntentSchema, type LiveCopyMandateIntent } from '@trading-dashboard/shared/contracts';
import { verifyLiveCopyMandateConsent, liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';

const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const now = 1791000000000;
const intent: LiveCopyMandateIntent = {
  mandateId: 'mandate', accountId: 'master-account', userId: 7, strategyId: 9, strategyVersion: 1,
  network: 'testnet', sourceNetwork: 'testnet', leaderAddress: `0x${'44'.repeat(20)}`,
  accountAddress: `0x${'22'.repeat(20)}`, accountRevision: 1, ownerAddress: owner.address.toLowerCase(), ownerPrivyUserId: 'did:privy:owner',
  setupId: 'setup', setupRevision: 2, executionWalletId: 'local-agent', agentWalletId: 'privy-agent', agentAddress: `0x${'33'.repeat(20)}`,
  authorizationId: 'grant', authorizationVersion: 4, policyId: 'policy', policyFingerprint: 'a'.repeat(64),
  workerQuorumId: 'worker', settingsDigest: 'b'.repeat(64), budgetUsd: '100', builderAddress: null, builderMaxFeeTenthsOfBps: 0,
  plannerVersion: 1, nonce: now, consentExpiresAt: now + 300000, expiresAt: now + 86400000,
};
describe('owner-signed actual copy mandate', () => {
  it('accepts only the exact current owner signature within the consent window', async () => {
    const signature = await owner.signTypedData(liveCopyMandateOwnerTypedData(intent));
    expect(await verifyLiveCopyMandateConsent(intent, signature, now + 1)).toBe(true);
    expect(await verifyLiveCopyMandateConsent(intent, signature, now - 1)).toBe(false);
    expect(await verifyLiveCopyMandateConsent(intent, signature, intent.consentExpiresAt)).toBe(false);
    expect(await verifyLiveCopyMandateConsent(intent, '0xbad', now + 1)).toBe(false);
  });
  it('cryptographically binds owner, wallet revisions, budget, source, fees and each generation', async () => {
    const signature = await owner.signTypedData(liveCopyMandateOwnerTypedData(intent));
    const changes: Partial<LiveCopyMandateIntent>[] = [
      { mandateId: 'other' }, { accountId: 'other' }, { userId: 8 }, { strategyId: 10 }, { strategyVersion: 2 },
      { sourceNetwork: 'mainnet' }, { leaderAddress: `0x${'55'.repeat(20)}` }, { accountAddress: `0x${'66'.repeat(20)}` },
      { accountRevision: 2 }, { ownerAddress: `0x${'77'.repeat(20)}` }, { ownerPrivyUserId: 'did:privy:other' },
      { setupId: 'other' }, { setupRevision: 3 }, { executionWalletId: 'other' }, { agentWalletId: 'other' },
      { agentAddress: `0x${'88'.repeat(20)}` }, { authorizationId: 'other' }, { authorizationVersion: 5 },
      { policyId: 'other' }, { policyFingerprint: 'c'.repeat(64) }, { workerQuorumId: 'other' },
      { settingsDigest: 'd'.repeat(64) }, { budgetUsd: '100.000001' },
      { builderAddress: `0x${'99'.repeat(20)}`, builderMaxFeeTenthsOfBps: 1 },
      { nonce: now + 1 }, { consentExpiresAt: now + 299999 }, { expiresAt: now + 86400001 },
    ];
    for (const change of changes) expect(await verifyLiveCopyMandateConsent({ ...intent, ...change }, signature, now + 2), JSON.stringify(change)).toBe(false);
  });
  it('rejects unsafe authority bounds, unsupported planner and extra signing material', () => {
    for (const change of [{ budgetUsd: '0' }, { budgetUsd: '1e2' }, { accountAddress: intent.ownerAddress },
      { builderMaxFeeTenthsOfBps: 1 }, { nonce: Number.MAX_SAFE_INTEGER + 1 }, { plannerVersion: 2 },
      { network: 'devnet' }, { consentExpiresAt: now + 300001 }, { expiresAt: now + 31 * 86400000 }, { userJwt: 'secret' }])
      expect(liveCopyMandateIntentSchema.safeParse({ ...intent, ...change }).success).toBe(false);
  });
  it('canonicalizes settings independent of JSONB key order and binds any changed setting', () => {
    const settings = { direction: 'same' as const, sizingMode: 'fixed' as const, perTradeUsd: 10, maxTotalExposureUsd: null, maxLeverage: 2, copyStartMode: 'delta' as const };
    const reordered = Object.fromEntries(Object.entries(settings).reverse());
    expect(liveCopySettingsDigest(settings)).toBe(liveCopySettingsDigest(reordered));
    expect(liveCopySettingsDigest({ ...settings, perTradeUsd: 11 })).not.toBe(liveCopySettingsDigest(settings));
    expect(() => liveCopySettingsDigest({ ...settings, token: 'secret' })).toThrow();
  });
});
