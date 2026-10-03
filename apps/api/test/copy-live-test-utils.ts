import type { ExchangeApprovalVerifier } from "../src/copy/live/wallet-authorization.js";
import type { LiveExecutionGate } from '../src/copy/live/live-execution-gate.js';

/** Explicit offline risk permit, only for execution-boundary test fixtures.
 * Concrete risk assessment is independently tested with real proof objects. */
export const executionGateFixture = (check: () => Promise<void> = async () => {}): LiveExecutionGate => ({
  assertReady: async ({ phase, record }) => {
    await check();
    return Object.freeze({ phase, key: record.key, fingerprint: record.fingerprint, assertFresh: () => {} });
  },
});

/** Explicit offline evidence fixture. Production has no allow-all verifier. */
export const exchangeApprovalFixture = (now: () => number): ExchangeApprovalVerifier => ({
  verify: async (grant) => ({ network: grant.network, accountAddress: grant.accountAddress,
    signerAddress: grant.signerAddress, checkedAt: now(), expiresAt: grant.expiresAt }),
});
