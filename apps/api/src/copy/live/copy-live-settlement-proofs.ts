import { inArray } from 'drizzle-orm';
import { copyLiveExecutionEvidence } from '@trading-dashboard/shared/database';
import type { DbExecutor } from '../../db/unit-of-work.js';
import { retainedSettlementProofRefs, type LiveGenerationManifestV1, type LiveSettlementProofs } from './copy-live-generation-projection.js';

/** The settlement proofs a sizing envelope's retained generation manifest
 * names by digest only (compactLiveGenerationManifest), read by journal key
 * from copy_live_execution_evidence in the caller's own session (`read` keeps
 * its post-query held-lock fence). A proof is returned only under the digest
 * its row stores; the projection verifies its content against that digest.
 * Undefined for an envelope retaining its proofs inline (admitted before). */
export async function loadLiveSettlementProofs(sizingBasis: unknown, db: DbExecutor,
  read: <T>(work: PromiseLike<T>) => Promise<T> = async work => await work, sameSnapshot?: LiveGenerationManifestV1): Promise<LiveSettlementProofs | undefined> {
  const refs = retainedSettlementProofRefs((sizingBasis as { observations?: { generationManifest?: unknown } } | null)?.observations?.generationManifest);
  if (!refs.length) return undefined;
  // `sameSnapshot`: the generation manifest `db` read in this same (repeatable
  // read) transaction, its evidence rows inline. A row it holds under the same
  // key and digest is the row this query would read; only the others are read.
  // Either way the projection verifies the content against the digest.
  const inline = new Map(sameSnapshot?.journals.flatMap(({ journal, evidence }) => evidence?.settlementProofDigest && evidence.settlementProof !== undefined
    && evidence.settlementProof !== null ? [[journal.key, { key: journal.key, digest: evidence.settlementProofDigest, proof: evidence.settlementProof }] as const] : []) ?? []);
  const missing = [...new Set(refs.filter(ref => inline.get(ref.key)?.digest !== ref.digest).map(ref => ref.key))];
  const rows = missing.length ? await read(db.select({ key: copyLiveExecutionEvidence.key, digest: copyLiveExecutionEvidence.settlementProofDigest, proof: copyLiveExecutionEvidence.settlementProof })
    .from(copyLiveExecutionEvidence).where(inArray(copyLiveExecutionEvidence.key, missing))) : [];
  const byKey = new Map<string, { key: string; digest: string | null; proof: unknown }>([...inline, ...rows.map(row => [row.key, row] as const)]), proofs: Record<string, unknown> = {};
  for (const ref of refs) {
    const row = byKey.get(ref.key);
    if (row && row.digest === ref.digest && row.proof !== null) proofs[ref.digest] = row.proof;
  }
  return proofs;
}
