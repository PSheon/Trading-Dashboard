import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';
import {
  canonicalLiveSourceLegs,
  parseLiveSourceFill,
  liveSourceDigest,
  liveSourceLegId,
} from '../src/copy/live/copy-live-source-evidence.js';
import {
  planLiveSourceOrder,
  type LiveSourcePlanInput,
} from '../src/copy/live/copy-live-source-planner.js';
import {
  sourceSizingExample,
  settledGenerationExample,
} from './copy-live-generation-test-utils.js';
import { fixture } from './copy-live-risk-test-utils.js';
import {
  buildOrderAction,
  executionKey,
  intentFingerprint,
} from '../src/copy/live/live-order.js';
import { planLiveReservation } from '../src/copy/live/live-risk-reservation.js';
import { assessLiveReservationSettlement } from '../src/copy/live/live-reservation-settlement.js';
import {
  captureLiveSettlementProof,
  decodeLiveSettlementProof,
} from '../src/copy/live/live-settlement-proof.js';
import {
  followerReceiptDigestV1,
  parseFollowerFill,
} from '../src/copy/live/actual-fill-accounting.js';
import { parseLiveOrderEvidence } from '../src/copy/live/live-order-evidence.js';
import type { LiveSourceSizingEnvelopeV1 } from '../src/copy/live/copy-live-sizing-evidence.js';
import type { LiveGenerationManifestV1 } from '../src/copy/live/copy-live-generation-projection.js';
const example = sourceSizingExample;
function closeExample(
  position = '90',
  carry = '15',
  full = false,
  mode: 'fixed' | 'ratio' = 'fixed',
  ageMs = 50,
  leaderSize?: string,
): LiveSourcePlanInput {
  const e = structuredClone(example(mode)),
    history = settledGenerationExample(position),
    manifest = history.manifest as any,
    o = (e.sizingBasis as any).observations,
    b = (e.sizingBasis as any).basis;
  (e as any).now = history.now;
  (e as any).currentExecutionKey = history.currentExecutionKey;
  manifest.journals[0].provenance.settingsDigest = e.mandate.settingsDigest;
  manifest.carry[0].carry = carry;
  manifest.carry[0].revision = 2;
  o.follower = history.snapshot;
  o.generationManifest = manifest;
  const fill = parseLiveSourceFill(
    {
      tid: 2,
      oid: 8,
      time: e.now - ageMs,
      coin: 'BTC',
      side: 'A',
      px: '100',
      sz: leaderSize ?? (full ? '4' : '1'),
      startPosition: '4',
    },
    {
      network: 'testnet',
      leaderAddress: e.mandate.leaderAddress,
      from: e.now - Math.max(1000, ageMs + 1),
      to: e.now,
      receivedAt: e.now,
      kind: 'fills',
    },
  );
  (e as any).fill = fill;
  (e as any).leg = canonicalLiveSourceLegs(fill)[0];
  Object.assign(b, {
    sourceFillId: fill.id,
    sourceDigest: fill.sourceDigest,
    leg: 'close',
    fixedTradeClaim: false,
    carry: { amount: carry, revision: 2 },
  });
  if (mode === 'ratio') {
    b.leader = null;
    o.leader = null;
  } // a close is not sized by the leader's capital
  Object.assign(b.follower, {
    positionSize: position,
    observedAt: history.snapshot.observedAt,
    completedAt: history.snapshot.completedAt,
    snapshotDigest: followerReceiptDigestV1(history.snapshot),
    positionsDigest: liveSourceDigest({ BTC: position }),
  });
  Object.assign(b.generation, {
    positionSize: position,
    receiptManifestDigest: liveSourceDigest({
      receipts: manifest.receipts,
      ledger: manifest.ledger,
    }),
    positionsDigest: liveSourceDigest({ BTC: position }),
  });
  return e;
}
export function adjustmentExample(held = '0.12', carry = '0', merged = false) {
  const input = closeExample(held, carry, false, merged ? 'ratio' : 'fixed'),
    envelope = input.sizingBasis as LiveSourceSizingEnvelopeV1;
  Object.assign(envelope.basis, { exchangeMinimum: true });
  const members = merged
    ? [
        parseLiveSourceFill(
          {
            tid: 3,
            oid: 9,
            time: input.now - 60,
            coin: 'BTC',
            side: 'A',
            px: '100',
            sz: '1',
            startPosition: '4',
          },
          {
            network: 'testnet',
            leaderAddress: input.mandate.leaderAddress,
            from: input.now - 1000,
            to: input.now,
            receivedAt: input.now,
            kind: 'fills',
          },
        ),
      ]
    : [];
  if (merged) {
    const all = [...members, input.fill];
    Object.assign(envelope.basis, {
      merged: {
        members: all.map((member) => {
          const l = canonicalLiveSourceLegs(member)[0]!;
          return {
            sourceFillId: member.id,
            sourceDigest: member.sourceDigest,
            providerTime: member.providerTime,
            sign: l.sign,
            size: l.size,
            px: member.px,
            fraction: l.fraction,
          };
        }),
      },
    });
    Object.assign(input, { members });
  }
  const f = fixture(),
    now = input.now,
    fill = input.fill,
    cloid = liveSourceExecutionCloid(input.mandate.id, fill.id, 'close');
  const key = `testnet:${f.identity.accountAddress}:${cloid}`;
  Object.assign(input, { currentExecutionKey: key });
  const plan = planLiveSourceOrder(input),
    { coin: _coin, ...order } = plan.order,
    intent = { ...f.intent, ...order, cloid, market: f.market },
    action = buildOrderAction(intent),
    fingerprint = intentFingerprint(intent, action);
  const history = settledGenerationExample(held),
    base = (history.manifest as LiveGenerationManifestV1).journals[0]!,
    proofInput = structuredClone(
      decodeLiveSettlementProof(
        base.evidence!.settlementProof,
        base.evidence!.settlementProofDigest!,
      ).input,
    );
  const record = {
    ...proofInput.record,
    key: executionKey(intent),
    fingerprint,
    action,
    state: 'unknown' as const,
    nonce: now,
    createdAt: now,
    updatedAt: now,
    expiresAfter: now + 60000,
  };
  const payload = planLiveReservation({
    now,
    identity: f.identity,
    localSource: f.localSource,
    intent,
    action,
    market: f.market,
    quote: f.quote,
    leverage: f.leverageProofs[0]!,
    fees: f.fees,
    policy: f.policy,
    expiresAt: now + 60000,
  });
  const raw = {
    coin: 'BTC',
    oid: 11,
    tid: 124,
    side: 'A',
    time: now + 5,
    sz: plan.order.size,
    px: '100',
    feeToken: 'USDC',
    fee: '0',
    builderFee: '0',
    closedPnl: '0',
  };
  const parsed = parseFollowerFill(raw, {
      network: 'testnet',
      accountAddress: f.identity.accountAddress,
    }),
    receipt = {
      key: parsed.key,
      accountId: 'account',
      network: 'testnet' as const,
      accountAddress: f.identity.accountAddress,
      kind: 'fill' as const,
      sourceId: parsed.tid,
      coin: parsed.coin,
      providerTime: parsed.time,
      digest: followerReceiptDigestV1(raw),
      record: { ...parsed, raw },
      executionKey: key,
      attribution: 'execution' as const,
      ledger: [],
    };
  const evidence = parseLiveOrderEvidence({
    record,
    market: f.market,
    raw: {
      status: 'order',
      order: {
        status: 'filled',
        statusTimestamp: now + 10,
        order: {
          coin: 'BTC',
          oid: 11,
          cloid,
          side: 'A',
          reduceOnly: true,
          tif: 'Ioc',
          origSz: plan.order.size,
          sz: '0',
          limitPx: plan.order.limitPrice,
          timestamp: now,
          isTrigger: false,
          isPositionTpsl: false,
          children: [],
        },
      },
    },
    checkedAt: now + 20,
    completedAt: now + 25,
    now: now + 100,
  });
  const source = structuredClone(f.accountSource);
  Object.assign(source, { checkedAt: now + 60 });
  Object.assign(source.snapshot, {
    observedAt: now + 30,
    completedAt: now + 50,
  });
  Object.assign(source.snapshot.coverage, { earliestProviderTime: now + 40 });
  Object.assign(source.snapshot.dexes[0]!, { providerTime: now + 40 });
  const settlementInput = {
    now: now + 100,
    accountId: 'account',
    record,
    reservation: {
      payload,
      state: 'unknown' as const,
      revision: 2,
      attemptedAt: now,
      exchangeOrderId: null,
      releaseEvidenceDigest: null,
      updatedAt: now,
    },
    evidence,
    acknowledgement: null,
    accountSource: source,
    receipts: {
      accountId: 'account',
      checkedAt: now + 70,
      completeForOrder: true as const,
      rows: [receipt],
    },
  };
  const decision = assessLiveReservationSettlement(settlementInput);
  if (decision.kind !== 'release')
    throw Error(`bad adjustment fixture ${decision.reason}`);
  const cert = decision.certificate,
    proof = captureLiveSettlementProof(settlementInput, cert),
    m = input.mandate;
  return {
    account: {
      id: 'account',
      strategyId: 9,
      network: 'testnet' as const,
      address: f.identity.accountAddress,
      privyUserId: m.ownerPrivyUserId,
    },
    userId: 1,
    receipt: { ...receipt, providerTime: new Date(receipt.providerTime) },
    row: {
      journal: {
        key,
        cloid,
        nonce: now,
        signerAddress: record.authorization.signerAddress,
        network: 'testnet' as const,
        accountAddress: f.identity.accountAddress,
        userId: 1,
        strategyId: 9,
        state: 'filled',
        record: { ...record, state: 'filled', updatedAt: now + 100 },
      },
      provenance: {
        key,
        legId: liveSourceLegId(m.id, fill.id, 'close'),
        mandateId: m.id,
        mandateRevision: m.revision,
        sourceDigest: fill.sourceDigest,
        settingsDigest: m.settingsDigest,
        fingerprint,
        plannerVersion: 1,
        intent,
        sizingBasis: envelope,
        admittedAt: new Date(now),
      },
      mandate: m,
      leg: {
        id: liveSourceLegId(m.id, fill.id, 'close'),
        mandateId: m.id,
        sourceFillId: fill.id,
        leg: 'close',
        tradeKey: input.leg.tradeKey,
        sign: input.leg.sign,
        size: input.leg.size,
        fraction: input.leg.fraction,
        fixedTradeClaim: false,
        dependsOnId: null,
        executionKey: key,
        state: 'settled',
      },
      fill: {
        ...fill,
        providerTime: new Date(fill.providerTime),
        receivedAt: new Date(fill.receivedAt),
      },
      members: members.map((member) => ({
        ...member,
        providerTime: new Date(member.providerTime),
        receivedAt: new Date(member.receivedAt),
      })),
      version: { strategyId: 9, version: 2, settings: input.settings },
      policy: { version: 3, limits: input.limits },
      reservation: {
        ...payload,
        key,
        cloid,
        accountId: 'account',
        state: 'released',
        revision: 3,
        strategyVersion: 2,
        authorizationVersion: 4,
        policyVersion: 3,
        payload,
        releaseReason: 'verified_settlement',
        exchangeOrderId: '11',
        releaseEvidenceDigest: cert.digest,
      },
      evidence: {
        key,
        accountId: 'account',
        userId: 1,
        strategyId: 9,
        network: 'testnet',
        accountAddress: f.identity.accountAddress,
        cloid,
        fingerprint,
        nonce: now,
        exchangeOrderId: '11',
        statusObservation: evidence,
        statusDigest: evidence.sourceDigest,
        settlementCertificate: cert,
        settlementDigest: cert.digest,
        settlementProof: proof.proof,
        settlementProofDigest: proof.digest,
      },
    },
  };
}
