import { inArray } from 'drizzle-orm';
import { copyLiveExecutionEvidence } from '@trading-dashboard/shared/database';
import type { DbExecutor } from '../../db/unit-of-work.js';
import { retainedSettlementProofRefs, type LiveSettlementProofs } from './copy-live-generation-projection.js';

/** The settlement proofs a sizing envelope's retained generation manifest
 * names by digest only (compactLiveGenerationManifest), read by journal key
 * from copy_live_execution_evidence in the caller's own session (`read` keeps
 * its post-query held-lock fence). A proof is returned only under the digest
 * its row stores; the projection verifies its content against that digest.
 * Undefined for an envelope retaining its proofs inline (admitted before). */
export async function loadLiveSettlementProofs(sizingBasis: unknown, db: DbExecutor,
  read: <T>(work: PromiseLike<T>) => Promise<T> = async work => await work): Promise<LiveSettlementProofs | undefined> {
  const refs = retainedSettlementProofRefs((sizingBasis as { observations?: { generationManifest?: unknown } } | null)?.observations?.generationManifest);
  if (!refs.length) return undefined;
  const rows = await read(db.select({ key: copyLiveExecutionEvidence.key, digest: copyLiveExecutionEvidence.settlementProofDigest, proof: copyLiveExecutionEvidence.settlementProof })
    .from(copyLiveExecutionEvidence).where(inArray(copyLiveExecutionEvidence.key, [...new Set(refs.map(ref => ref.key))])));
  const byKey = new Map(rows.map(row => [row.key, row] as const)), proofs: Record<string, unknown> = {};
  for (const ref of refs) {
    const row = byKey.get(ref.key);
    if (row && row.digest === ref.digest && row.proof !== null) proofs[ref.digest] = row.proof;
  }
  return proofs;
}
