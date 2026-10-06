import { describe, expect, it } from 'vitest';
import { liveCopyMandateIntentSchema, type LiveCopyMandateIntent } from '@trading-dashboard/shared/contracts';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';

const now = 1791000000000;
const intent: LiveCopyMandateIntent = {
  mandateId: 'mandate', accountId: 'master-account', userId: 7, strategyId: 9, strategyVersion: 1,
  network: 'testnet', sourceNetwork: 'testnet', leaderAddress: `0x${'44'.repeat(20)}`,
  accountAddress: `0x${'22'.repeat(20)}`, accountRevision: 1, ownerAddress: `0x${'11'.repeat(20)}`, ownerPrivyUserId: 'did:privy:owner',
  setupId: 'setup', setupRevision: 2, executionWalletId: 'local-agent', agentWalletId: 'privy-agent', agentAddress: `0x${'33'.repeat(20)}`,
  authorizationId: 'grant', authorizationVersion: 4, policyId: 'policy', policyFingerprint: 'a'.repeat(64),
  workerQuorumId: 'worker', settingsDigest: 'b'.repeat(64), budgetUsd: '100', builderAddress: null, builderMaxFeeTenthsOfBps: 0,
  plannerVersion: 1, nonce: now, consentExpiresAt: now + 300000, expiresAt: now + 86400000,
};
describe('the server-filled actual copy mandate intent', () => {
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
