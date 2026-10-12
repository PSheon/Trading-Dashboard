import { expect, it } from 'vitest';
import type { DbExecutor } from '../src/db/unit-of-work.js';
import { loadLiveSettlementProofs } from '../src/copy/live/copy-live-settlement-proofs.js';
import { compactLiveGenerationManifest, type LiveGenerationManifestV1 } from '../src/copy/live/copy-live-generation-projection.js';
import { settledGenerationExample } from './copy-live-generation-test-utils.js';

/** A database answering the evidence query with `rows`, counting the queries. */
function database(rows: { key: string; digest: string | null; proof: unknown }[]) {
  const asked: number[] = [];
  const db = { select: () => ({ from: () => ({ where: () => { asked.push(1); return Promise.resolve(rows); } }) }) } as unknown as DbExecutor;
  return { db, asked };
}

it('a gate read takes the settled proofs its envelope names from the manifest read in the same snapshot, and reads only the others', async () => {
  const manifest = settledGenerationExample().manifest as LiveGenerationManifestV1, entry = manifest.journals[0]!;
  const envelope = { observations: { generationManifest: compactLiveGenerationManifest(manifest) } };
  const digest = entry.evidence!.settlementProofDigest!, inline = entry.evidence!.settlementProof;
  // Every named proof is in the same-snapshot manifest: no second read.
  const same = database([]);
  expect(await loadLiveSettlementProofs(envelope, same.db, undefined, manifest)).toEqual({ [digest]: inline });
  expect(same.asked).toHaveLength(0);
  // The manifest holds the journal under another digest: that one is read (and
  // kept only under the digest the envelope names, as before).
  const other: LiveGenerationManifestV1 = { ...manifest, journals: [{ ...entry, evidence: { ...entry.evidence!, settlementProofDigest: 'f'.repeat(64) } }] };
  const read = database([{ key: entry.journal.key, digest, proof: inline }]);
  expect(await loadLiveSettlementProofs(envelope, read.db, undefined, other)).toEqual({ [digest]: inline });
  expect(read.asked).toHaveLength(1);
  // Without a same-snapshot manifest every named proof is read.
  const none = database([{ key: entry.journal.key, digest, proof: inline }]);
  expect(await loadLiveSettlementProofs(envelope, none.db)).toEqual({ [digest]: inline });
  expect(none.asked).toHaveLength(1);
});
