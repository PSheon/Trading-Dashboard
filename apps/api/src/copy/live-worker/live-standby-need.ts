import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';

import { liveEvidenceWeight } from '../live/live-shared-reads.js';
import { liveReadCache, type LiveReadCache } from '../live/live-read-cache.js';
import { mirrorsLeader } from './copy-live-engine.js';
import type { LiveMandateWork } from './copy-live-worker.repository.js';
import { LIVE_ORDER_BOUNDARY_WEIGHT } from '../../config/constants/weights.js';

/**
 * What the shared meter's live standby keeps free (design §8 I-14): the
 * heaviest order the generations that mirror their leader could send now,
 * weighed as LiveExecutionRuntime will weigh it before its SQL locks
 * (liveEvidenceWeight + the boundary). The account's reads the cross-order
 * cache holds are not paid again, and the owner's other live accounts
 * count as uncached. A ratio copy of a leader on the deployment's own
 * network reads the leader too.
 *
 * About 385 for one account cold, about 65 plus the leader's 4 once the
 * cache is warm, against the startup bound of 793 (`cap`, the heaviest
 * evidence the bucket must hold: never more than that). Holding the
 * startup bound kept two thirds of the window idle for background while a
 * copy with one account ran. The engine renews the standby every 10 s, so
 * a cache entry that lapses raises it at the next renewal; an order that
 * finds less than its need free still announces its full need
 * (claimLive) and is served first.
 *
 * The owner's accounts are counted from these generations (one per
 * account); the runtime counts every account with live exposure, which an
 * account without a current generation adds to (its order then announces
 * the rest).
 */
export function liveStandbyNeed(mandates: readonly LiveMandateWork[], network: HyperliquidNetwork, cap: number, cache: LiveReadCache = liveReadCache(network)): number {
  const accounts = new Map<number, Set<string>>();
  for (const m of mandates) {
    const owned = accounts.get(m.userId) ?? new Set<string>();
    owned.add(m.accountId);
    accounts.set(m.userId, owned);
  }
  let need = 0;
  for (const m of mandates) {
    if (!mirrorsLeader(m)) continue;
    const others = Math.max(0, (accounts.get(m.userId)?.size ?? 1) - 1);
    const leader = m.sourceNetwork === network && m.sizingMode === 'ratio';
    need = Math.max(need, liveEvidenceWeight([m.accountAddress.toLowerCase()], others, cache, leader ? [m.leaderAddress.toLowerCase()] : []) + LIVE_ORDER_BOUNDARY_WEIGHT);
  }
  return Math.min(cap, need);
}
