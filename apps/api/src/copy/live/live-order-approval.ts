import { LiveBoundaryError, type ExchangeApprovalEvidence, type ExchangeApprovalVerifier } from './wallet-authorization.js';

/** Private to one execution. SQL grant reads and actual-POST freshness checks
 * still run every time; reuse never changes the exchange observation clock. */
export const APPROVAL_REUSE_MS = 5000;
export function orderApproval(verifier: ExchangeApprovalVerifier, now: () => number): ExchangeApprovalVerifier {
  let last: { key: string; evidence: Promise<ExchangeApprovalEvidence> } | undefined;
  return { verify: async grant => {
    const key = JSON.stringify([grant.network, grant.accountAddress, grant.signerAddress, grant.id, grant.version]);
    if (last?.key === key) {
      const evidence = await last.evidence.catch(() => undefined);
      if (evidence && now() >= evidence.checkedAt && now() - evidence.checkedAt <= APPROVAL_REUSE_MS) {
        if (evidence.expiresAt !== null && evidence.expiresAt <= now()) throw new LiveBoundaryError('exchange_agent_expired');
        return structuredClone(evidence);
      }
    }
    const evidence = verifier.verify(grant);
    last = { key, evidence };
    return structuredClone(await evidence);
  } };
}
