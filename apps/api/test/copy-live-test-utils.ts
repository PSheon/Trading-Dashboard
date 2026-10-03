import type { ExchangeApprovalVerifier } from "../src/copy/live/wallet-authorization.js";

/** Explicit offline evidence fixture. Production has no allow-all verifier. */
export const exchangeApprovalFixture = (now: () => number): ExchangeApprovalVerifier => ({
  verify: async (grant) => ({ network: grant.network, accountAddress: grant.accountAddress,
    signerAddress: grant.signerAddress, checkedAt: now(), expiresAt: grant.expiresAt }),
});
