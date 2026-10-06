import type { copyLiveSourceFills } from '@trading-dashboard/shared/database';
import { decodeLiveSourceFill, type LiveSourceFillEvidence } from './copy-live-source-evidence.js';
import { mergedMemberIds } from './copy-live-source-planner.js';

/** A merged sizing basis's other legs, decoded from their persisted source
 * fills (`select` reads copy_live_source_fills by id in the caller's own
 * session), for the planner to verify. Undefined when it lists none. */
export async function loadMergedMembers(sizingBasis: unknown, ownFillId: string,
  select: (ids: string[]) => Promise<(typeof copyLiveSourceFills.$inferSelect)[]>): Promise<LiveSourceFillEvidence[] | undefined> {
  const ids = mergedMemberIds(sizingBasis, ownFillId);
  if (!ids.length) return undefined;
  return (await select(ids)).map(decodeLiveSourceFill);
}
