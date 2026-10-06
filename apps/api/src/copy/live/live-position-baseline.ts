import { isDeepStrictEqual } from 'node:util';
import { isHyperliquidNetwork, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { LiveAccountSnapshot } from './live-account-observer.js';
import { mapLiveAccountView } from './live-account-view.js';
import { followerReceiptDigestV1 } from './actual-fill-accounting.js';
import { LiveBoundaryError, address } from './wallet-authorization.js';
import { freezeLiveReservation } from './live-risk-reservation.js';
import { Dec } from '../../common/decimal/dec.js';

export interface LivePositionBaselineIdentity {
  mandateId: string; accountId: string; strategyId: number; firstExecutionKey: string; network: HyperliquidNetwork; accountAddress: string;
}
export interface LivePositionBaseline extends LivePositionBaselineIdentity {
  observedAt: number; completedAt: number; createdAt: number; sourceDigest: string; snapshotDigest: string; baselineDigest: string;
  snapshot: LiveAccountSnapshot; producerVersion: 1;
}
const fail = (): never => { throw new LiveBoundaryError('live_risk_baseline_unproven'); };
/** Capture only at the first atomic execution preparation. Local journal,
 * provenance and absence-of-other-liability checks are coordinator duties.
 * This immutable empty observation is an initial quantity anchor, never a
 * current account risk permit or evidence to adopt an existing position. */
export function captureLivePositionBaseline(identity: LivePositionBaselineIdentity, snapshot: LiveAccountSnapshot, now: number): LivePositionBaseline {
  try {
    if (!isHyperliquidNetwork(identity.network) || !identity.mandateId || !identity.accountId || !Number.isSafeInteger(identity.strategyId) || identity.strategyId < 1 ||
      address(identity.accountAddress) !== identity.accountAddress || !identity.firstExecutionKey.startsWith(`${identity.network}:${identity.accountAddress}:`) ||
      !/^0x[0-9a-f]{32}$/.test(identity.firstExecutionKey.slice(`${identity.network}:${identity.accountAddress}:`.length))) fail();
    const view = mapLiveAccountView(identity, snapshot, { blocked: false, reason: null }, now, 5000);
    if (view.freshness !== 'fresh' || snapshot.positions.length || snapshot.restingOrders.length ||
      !Dec.from(snapshot.totalMarginUsed).isZero || !Dec.from(snapshot.exposureUsd).isZero ||
      snapshot.dexes.some(d => !Dec.from(d.marginUsed).isZero || !Dec.from(d.crossMarginUsed).isZero || !Dec.from(d.crossMaintenanceMarginUsed).isZero)) fail();
    const body = { ...identity, observedAt: snapshot.observedAt, completedAt: snapshot.completedAt, createdAt: now,
      sourceDigest: snapshot.sourceDigest, snapshotDigest: followerReceiptDigestV1(snapshot), snapshot: structuredClone(snapshot), producerVersion: 1 as const };
    return freezeLiveReservation({ ...body, baselineDigest: followerReceiptDigestV1(body) });
  } catch { return fail(); }
}
/** Historical validation preserves the original observation and capture time.
 * A digest alone grants no authority: rows must come from the coordinator's
 * restricted SQL path and bind the current mandate's first execution. */
export function decodeLivePositionBaseline(identity: LivePositionBaselineIdentity, raw: unknown): LivePositionBaseline {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
    const row = raw as LivePositionBaseline;
    const expected = captureLivePositionBaseline(identity, row.snapshot, row.createdAt);
    if (!isDeepStrictEqual(expected, raw)) fail();
    return expected;
  } catch { return fail(); }
}
