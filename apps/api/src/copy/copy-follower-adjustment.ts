import { isDeepStrictEqual } from 'node:util';
import {
  copyRiskLimitsSchema,
  copyStrategySettingsSchema,
  type CopyFollowerActivityItem,
} from '@trading-dashboard/shared/contracts';
import type {
  copyLiveExecutions,
  copyLiveIntentProvenance,
  copyLiveMandates,
  copyLiveSignalLegs,
  copyLiveSourceFills,
  copyLiveRiskReservations,
  copyLiveExecutionEvidence,
  copyStrategyVersions,
  copyRiskPolicies,
} from '@trading-dashboard/shared/database';
import { Dec } from '../common/decimal/dec.js';
import { EXCHANGE_MIN_ORDER_NOTIONAL_USD } from './min-order-notional.js';
import { reduceWithCarry, floorSize } from './copy-math.js';
import { decodeLiveCopyMandate } from './copy-live-mandate-evidence.js';
import {
  decodeLiveSourceSizingEnvelope,
  combinedCloseFraction,
  planLiveSourceOrder,
  mergedMemberIds,
} from './live/copy-live-source-planner.js';
import {
  decodeLiveSourceFill,
  canonicalLiveSourceLegs,
} from './live/copy-live-source-evidence.js';
import { decodeLiveSettlementProof } from './live/live-settlement-proof.js';
import { executionKey, intentFingerprint } from './live/live-order.js';
import { liveSourceExecutionCloid } from './live/postgres-live-preparation.js';
import type { LiveExecutionRecord } from './live/live-execution.js';

export type FollowerAdjustment = NonNullable<
  Extract<CopyFollowerActivityItem, { kind: 'fill' }>['adjustment']
>;
export type FollowerAdjustmentEvidence = {
  journal: typeof copyLiveExecutions.$inferSelect;
  provenance: typeof copyLiveIntentProvenance.$inferSelect;
  mandate: typeof copyLiveMandates.$inferSelect;
  leg: typeof copyLiveSignalLegs.$inferSelect;
  fill: typeof copyLiveSourceFills.$inferSelect;
  reservation: typeof copyLiveRiskReservations.$inferSelect;
  evidence: typeof copyLiveExecutionEvidence.$inferSelect;
  version: typeof copyStrategyVersions.$inferSelect;
  policy: typeof copyRiskPolicies.$inferSelect;
  members: (typeof copyLiveSourceFills.$inferSelect)[];
};
export type FollowerAdjustmentContext = {
  userId: number;
  account: {
    id: string;
    strategyId: number;
    network: 'testnet' | 'mainnet';
    address: string;
    privyUserId: string;
  };
  receipt: {
    key: string;
    digest: string;
    executionKey: string | null;
    oid: string;
    coin: string;
    side: 'B' | 'A';
  };
};
function requireOriginal(value: unknown): asserts value {
  if (!value) throw Error('unproven original adjustment');
}
/** History content verification only. Replays at admission's original clock;
 * never produces a financial permit, current price or new sizing evidence. */
export function originalFollowerAdjustment(
  context: FollowerAdjustmentContext,
  raw: FollowerAdjustmentEvidence | undefined,
): FollowerAdjustment | null {
  try {
    if (!raw || !context.receipt.executionKey) return null;
    const {
      journal: j,
      provenance: p,
      mandate: m,
      leg: l,
      fill: f,
      reservation: r,
      evidence: e,
      version: v,
      policy,
      members,
    } = raw;
    requireOriginal(j && p && m && l && f && r && e && v && policy);
    requireOriginal(
      Buffer.byteLength(JSON.stringify(p.sizingBasis)) <= 2 * 1024 * 1024 &&
        Buffer.byteLength(JSON.stringify(j.record)) <= 16384 &&
        Buffer.byteLength(JSON.stringify(p.intent)) <= 16384 &&
        Buffer.byteLength(JSON.stringify(e.settlementProof)) <= 2097152 &&
        members.length <= 63 &&
        Buffer.byteLength(JSON.stringify(members)) <= 2097152,
    );
    requireOriginal(
      r.state === 'released' &&
        r.releaseReason === 'verified_settlement' &&
        e.settlementProof &&
        e.settlementProofDigest,
    );
    const proof = decodeLiveSettlementProof(
        e.settlementProof,
        e.settlementProofDigest,
      ),
      cert = proof.certificate,
      record = j.record as unknown as LiveExecutionRecord;
    const { account: a, receipt } = context,
      consent = decodeLiveCopyMandate(m),
      envelope = decodeLiveSourceSizingEnvelope(p.sizingBasis),
      b = envelope.basis;
    requireOriginal(
      j.key === receipt.executionKey &&
        p.key === j.key &&
        r.key === j.key &&
        e.key === j.key &&
        cert.key === j.key &&
        executionKey(p.intent as never) === j.key,
    );
    for (const owner of [j, r, e, consent])
      requireOriginal(
        owner.userId === context.userId &&
          owner.strategyId === a.strategyId &&
          owner.network === a.network &&
          owner.accountAddress === a.address,
      );
    requireOriginal(
      r.accountId === a.id &&
        e.accountId === a.id &&
        cert.accountId === a.id &&
        consent.accountId === a.id &&
        consent.ownerPrivyUserId === a.privyUserId,
    );
    requireOriginal(
      p.mandateId === m.id &&
        l.mandateId === m.id &&
        p.legId === l.id &&
        l.executionKey === j.key &&
        l.sourceFillId === f.id &&
        l.state === 'settled' &&
        l.leg === 'close',
    );
    requireOriginal(
      m.revision >= p.mandateRevision &&
        p.mandateRevision === b.mandateRevision &&
        p.admittedAt.getTime() === record.createdAt &&
        p.plannerVersion === 1 &&
        p.settingsDigest === consent.settingsDigest &&
        p.fingerprint === record.fingerprint,
    );
    requireOriginal(
      consent.strategyVersion === r.strategyVersion &&
        v.strategyId === a.strategyId &&
        v.version === r.strategyVersion &&
        policy.version === r.policyVersion,
    );
    requireOriginal(
      consent.authorizationId === r.authorizationId &&
        consent.authorizationVersion === r.authorizationVersion &&
        consent.agentWalletId === r.walletId &&
        consent.agentAddress === record.authorization.signerAddress,
    );
    const original = r.payload;
    requireOriginal(
      original.accountId === a.id &&
        original.userId === context.userId &&
        original.strategyId === a.strategyId &&
        original.network === a.network &&
        original.accountAddress === a.address &&
        original.strategyVersion === r.strategyVersion &&
        original.policyVersion === r.policyVersion &&
        original.authorizationVersion === r.authorizationVersion &&
        original.authorizationId === r.authorizationId &&
        original.walletId === r.walletId &&
        original.fingerprint === p.fingerprint,
    );
    requireOriginal(
      record.authorization.id === consent.authorizationId &&
        record.authorization.version === consent.authorizationVersion &&
        record.authorization.userId === context.userId &&
        record.authorization.strategyId === a.strategyId &&
        record.authorization.walletId === consent.agentWalletId &&
        record.authorization.network === a.network &&
        record.authorization.accountAddress === a.address,
    );
    requireOriginal(
      cert.fingerprint === p.fingerprint &&
        cert.nonce === record.nonce &&
        cert.cloid === e.cloid,
    );
    requireOriginal(
      j.cloid === e.cloid &&
        j.cloid === r.cloid &&
        j.nonce === e.nonce &&
        j.nonce === record.nonce &&
        j.signerAddress === record.authorization.signerAddress,
    );
    requireOriginal(
      r.revision === cert.reservationRevision + 1 &&
        r.exchangeOrderId === cert.oid &&
        e.exchangeOrderId === cert.oid &&
        r.fingerprint === p.fingerprint &&
        receipt.oid === cert.oid &&
        r.releaseEvidenceDigest === cert.digest &&
        e.settlementDigest === cert.digest &&
        e.fingerprint === p.fingerprint,
    );
    requireOriginal(
      isDeepStrictEqual(e.settlementCertificate, cert) &&
        isDeepStrictEqual(e.statusObservation, proof.input.evidence) &&
        e.statusDigest === proof.input.evidence.sourceDigest &&
        isDeepStrictEqual(r.payload, proof.input.reservation.payload),
    );
    requireOriginal(
      cert.receipts.some(
        (item) => item.key === receipt.key && item.digest === receipt.digest,
      ),
    );
    for (const field of [
      'key',
      'fingerprint',
      'authorization',
      'action',
      'market',
      'nonce',
      'expiresAfter',
      'createdAt',
    ] as const)
      requireOriginal(
        isDeepStrictEqual(record[field], proof.input.record[field]),
      );
    requireOriginal(
      isDeepStrictEqual(p.intent, r.payload.intent) &&
        intentFingerprint(p.intent as never, record.action) === p.fingerprint,
    );
    requireOriginal(j.cloid === liveSourceExecutionCloid(m.id, f.id, 'close'));
    const fill = decodeLiveSourceFill(f),
      canonical = canonicalLiveSourceLegs(fill).find(
        (item) => item.leg === 'close',
      );
    requireOriginal(
      canonical &&
        fill.network === consent.sourceNetwork &&
        fill.leaderAddress === consent.leaderAddress &&
        fill.sourceDigest === p.sourceDigest &&
        receipt.coin === fill.coin,
    );
    requireOriginal(
      l.tradeKey === canonical.tradeKey &&
        l.sign === canonical.sign &&
        l.size === canonical.size &&
        l.fraction === canonical.fraction,
    );
    const ids = mergedMemberIds(envelope, fill.id);
    requireOriginal(
      ids.length === members.length &&
        ids.every((id) => members.some((member) => member.id === id)),
    );
    const plan = planLiveSourceOrder({
      mandate: { ...m, state: 'active', revision: p.mandateRevision },
      settings: copyStrategySettingsSchema.strict().parse(v.settings),
      fill,
      leg: canonical,
      sizingBasis: envelope,
      now: record.createdAt,
      limits: copyRiskLimitsSchema.parse(policy.limits),
      currentExecutionKey: j.key,
      ...(members.length ? { members: members.map(decodeLiveSourceFill) } : {}),
    });
    requireOriginal(
      plan.legId === l.id &&
        plan.fixedTradeClaim === l.fixedTradeClaim &&
        plan.dependsOnLegId === l.dependsOnId,
    );
    const intent = p.intent;
    for (const field of [
      'asset',
      'side',
      'size',
      'limitPrice',
      'sizeDecimals',
      'reduceOnly',
      'timeInForce',
    ] as const)
      requireOriginal(plan.order[field] === intent[field]);
    requireOriginal(plan.order.reduceOnly && receipt.side === plan.order.side);
    if (b.exchangeMinimum !== true) return null;
    const fraction = b.merged
      ? combinedCloseFraction(
          b.merged.members.map((member) => member.fraction!),
        )
      : Dec.from(canonical.fraction!);
    const held = Dec.from(b.generation.positionSize).abs(),
      requested = floorSize(
        reduceWithCarry(
          held,
          fraction,
          Dec.from(b.carry.amount),
          b.market.sizeDecimals,
        ).size,
        b.market.sizeDecimals,
      );
    // The original planner alone chooses the final size. This explains only
    // its minimum-order full-close branch, never a full leader close or carry
    // that already requested the whole position. Actual fills remain separate.
    if (
      !fraction.isPositive ||
      fraction.gte(1) ||
      !requested.lt(held) ||
      !Dec.from(plan.order.size).eq(held) ||
      !requested
        .mul(
          Dec.min(Dec.from(b.quote.midPrice), Dec.from(plan.order.limitPrice)),
        )
        .lt(EXCHANGE_MIN_ORDER_NOTIONAL_USD)
    )
      return null;
    return {
      requestedFraction: fraction.toString(),
      requestedSize: requested.toString(),
      plannedSize: plan.order.size,
      reason: 'minimum_reduce_full_close',
      admittedAt: p.admittedAt.toISOString(),
    };
  } catch {
    return null;
  }
}
