import { isDeepStrictEqual } from 'node:util';
import { liveSourceExecutionCloid } from './copy-live-leg-attempt.js';
import { isDefinitelyUnsent } from './live-execution.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { copyLiveDispatches, copyLiveExecutions, copyLiveIntentProvenance, copyLiveSignalLegs, copyLiveSourceFills, copyLiveSourceStreams,
  copyLivePositionBaselines, copyLiveReductionCarry, copyFollowerReceipts, copyLiveRiskReservations } from '@trading-dashboard/shared/database';
import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { DbExecutor } from '../../db/unit-of-work.js';
import { allocateSignerNonce } from '../signer-nonce.js';
import { Dec } from '../../common/decimal/dec.js';
import { assertOriginalLiveRiskSession, type LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { liveSourceStreamAdmits, loadLivePreparationAuthority, riskSourceDigest, riskSourceRequire } from './postgres-live-risk-authority.js';
import { loadLiveGenerationManifest } from './postgres-live-generation-manifest.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceLegId } from './copy-live-source-evidence.js';
import { planLiveSourceOrder } from './copy-live-source-planner.js';
import type { LiveSourceSizingEnvelopeV1 } from './copy-live-sizing-evidence.js';
import { compactLiveGenerationManifest, liveGenerationProofsByDigest, liveSettlementProofsOf, LiveGenerationProjectionMemo, projectLiveGenerationPositions, type LiveGenerationManifestV1 } from './copy-live-generation-projection.js';
import { freezeLiveReservation } from './live-risk-reservation.js';
import { captureLivePositionBaseline } from './live-position-baseline.js';
import { followerReceiptDigestV1 } from './actual-fill-accounting.js';
import { HyperliquidLiveAccountObserver } from './live-account-observer.js';
import { HyperliquidLiveMarketResolver } from './live-market-resolver.js';
import { HyperliquidLiveRiskProvider, type LiveRiskProviderOptions } from './live-risk-provider.js';
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from './live-order.js';
import { decodeLiveExecutionRow } from './postgres-live-journal.js';
import type { LiveExecutionRecord } from './live-execution.js';
import { address, assertWalletAuthorization, LiveBoundaryError } from './wallet-authorization.js';
import { LiveProviderReadEpoch } from './live-provider-read-epoch.js';
import { assertLiveSourcePrice, compareMergedLegs, MAX_MERGED_LEGS } from './copy-live-source-planner.js';
import type { LiveSourceReferenceReader } from './live-source-reference.js';
import type { LiveSourceReferenceV1 } from './copy-live-sizing-evidence.js';
import { minOrderNotional } from '../min-order-notional.js';
import { effectiveLeverage } from '../copy-risk.js';
import { leverageReductionMarginFits, LiveLeverageUpdateRequired } from './live-leverage-update.js';
import { liveDeploymentPolicy } from '../live-deployment.js';
import { beginLiveExecutionTiming, type LiveExecutionTimingHook } from './live-execution-diagnostics.js';

interface LivePreparationBinding {
  readonly accountId: string; readonly mandateId: string; readonly sourceFillId: string; readonly leg: 'open' | 'close';
  /** Other same-coin leader legs this order also carries (one merged follower
   * adjustment, ratio sizing): their source fill ids, each with this leg. */
  readonly members?: readonly string[];
  /** Which order of the leg this is (copy-live-leg-attempt.ts): 0 or absent
   * for its original order; k > 0 only after attempt k - 1 was released as
   * never sent. Never with members (a merged adjustment is not re-planned). */
  readonly attempt?: number;
}
export interface LivePreparationOptions extends LiveRiskProviderOptions {
  readonly slippageBps: string;
  /** Largest difference (bps) between the execution network's mid and the
   * source network's at which a leader's open on another network is still
   * mirrored. Required when the source network differs from the execution network. */
  readonly maxSourceDeviationBps?: string;
}
export { liveSourceExecutionCloid } from './copy-live-leg-attempt.js';
import { MAX_LIVE_LEG_ATTEMPTS } from '../../config/constants/limits.js';
import { liveEvidenceMaxAgeMs } from '../../config/live-evidence-window.js';

/** Prepares authority, never signs or submits. All remote observations occur
 * outside SQL; the first baseline, canonical source claim, monotonic nonce,
 * exact intent and provenance commit together on the original connection. */
export class PostgresLivePreparation {
  private readonly options: Readonly<LivePreparationOptions>;
  private readonly epoch: LiveProviderReadEpoch;
  constructor(private readonly observer: HyperliquidLiveAccountObserver, resolver: HyperliquidLiveMarketResolver,
    provider: HyperliquidLiveRiskProvider, options: LivePreparationOptions, private readonly now = Date.now, epoch?: LiveProviderReadEpoch,
    private readonly reference?: LiveSourceReferenceReader,
    private readonly beforeProviderRead?: (walletId: string) => void,
    private readonly onTiming?: LiveExecutionTimingHook) {
    this.options = Object.freeze(structuredClone(options));
    riskSourceRequire(Dec.from(options.slippageBps).gte(0) && Dec.from(options.slippageBps).lte(10000), 'live_preparation_options');
    this.epoch = epoch ?? new LiveProviderReadEpoch(observer, resolver, provider, options, now);
    riskSourceRequire(this.epoch instanceof LiveProviderReadEpoch, 'live_risk_source_unavailable');
  }
  private async checked<T>(session: LiveRiskDatabaseSession, query: PromiseLike<T>): Promise<T> {
    const result = await query; await session.scope.assertHeld(); return result;
  }
  private fresh(started: number): void {
    const now = this.now();
    riskSourceRequire(Number.isSafeInteger(now) && now >= started && now - started <= liveEvidenceMaxAgeMs(), 'live_risk_stale');
  }
  async prepare(session: LiveRiskDatabaseSession, supplied: LivePreparationBinding): Promise<{ intent: LiveOrderIntent; record: LiveExecutionRecord }> {
    assertOriginalLiveRiskSession(session);
    const binding = Object.freeze(structuredClone(supplied)), started = this.now();
    const mark = beginLiveExecutionTiming(this.observer.network, 'prepare', this.now, this.onTiming);
    riskSourceRequire(binding && ['open', 'close'].includes(binding.leg) && [binding.accountId, binding.mandateId, binding.sourceFillId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 160) &&
      (binding.members === undefined || Array.isArray(binding.members) && binding.members.length >= 1 && binding.members.length < MAX_MERGED_LEGS &&
        binding.members.every(v => typeof v === 'string' && v.length > 0 && v.length <= 160 && v !== binding.sourceFillId) && new Set(binding.members).size === binding.members.length) &&
      (binding.attempt === undefined || Number.isSafeInteger(binding.attempt) && binding.attempt >= 0 && binding.attempt < MAX_LIVE_LEG_ATTEMPTS && (binding.attempt === 0 || binding.members === undefined)), 'live_preparation_binding');
    const attempt = binding.attempt ?? 0;
    const local = await session.read(db => loadLivePreparationAuthority(session, db, binding, started));
    mark('preparation_local_authority');
    // The execution network: the account's (the authority binds it to the scope).
    const network = local.account.network;
    const cloid = liveSourceExecutionCloid(binding.mandateId, binding.sourceFillId, binding.leg, attempt), key = executionKey({ network, accountAddress: address(local.account.address!), cloid });
    // A later attempt replaces exactly the previous one, which must have been
    // released as never sent (checked again under the journal transaction).
    const previousKey = attempt ? executionKey({ network, accountAddress: address(local.account.address!), cloid: liveSourceExecutionCloid(binding.mandateId, binding.sourceFillId, binding.leg, attempt - 1) }) : null;
    const existing = await session.read(async db => {
      const [row] = await this.checked(session, db.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key)));
      if (!row) return null;
      const [provenance] = await this.checked(session, db.select().from(copyLiveIntentProvenance).where(eq(copyLiveIntentProvenance.key, key)));
      riskSourceRequire(provenance && provenance.mandateId === binding.mandateId && provenance.legId === liveSourceLegId(binding.mandateId, binding.sourceFillId, binding.leg) &&
        provenance.attempt === attempt, 'live_preparation_conflict');
      const intent = structuredClone(provenance.intent) as unknown as LiveOrderIntent, record = decodeLiveExecutionRow(row);
      riskSourceRequire(executionKey(intent) === key && record.fingerprint === intentFingerprint(intent, buildOrderAction(intent)) && record.fingerprint === provenance.fingerprint, 'live_preparation_conflict');
      await session.scope.assertHeld();
      return { intent, record };
    });
    mark('preparation_existing_identity');
    // An original attempted/expired identity is retained, never re-priced or
    // given another nonce. The executor's reconciliation owns its next step.
    if (existing) return existing;
    const source = await session.read(async db => {
      const [row] = await this.checked(session, db.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.id, binding.sourceFillId)));
      riskSourceRequire(row, 'live_preparation_source');
      const fill = decodeLiveSourceFill(row), [stream] = await this.checked(session, db.select().from(copyLiveSourceStreams).where(eq(copyLiveSourceStreams.id, fill.streamId)));
      // The stream admits this leg now (liveSourceStreamAdmits, D10: a close while the stream is in gap), else a
      // wait; a close whose fill a gap read stored beyond the proven coverage waits for the stream too.
      riskSourceRequire(stream && liveSourceStreamAdmits(stream, binding.leg), 'live_risk_source_not_ready');
      riskSourceRequire(stream.network === local.consent.sourceNetwork && stream.leaderAddress === local.consent.leaderAddress &&
        fill.leaderAddress === local.consent.leaderAddress && fill.network === local.consent.sourceNetwork && fill.providerTime > local.mandate.activationCursor!.getTime() &&
        stream.coverageFrom.getTime() <= local.mandate.activationCursor!.getTime(), 'live_preparation_source');
      riskSourceRequire(stream.coverageThrough.getTime() >= fill.providerTime, stream.state === 'ready' ? 'live_preparation_source' : 'live_risk_source_not_ready');
      const leg = canonicalLiveSourceLegs(fill).find(v => v.leg === binding.leg);
      riskSourceRequire(leg, 'live_preparation_source');
      // A merged adjustment's other legs: the same stream, coin, kind and
      // side, inside the proven coverage, after the cursor. Only plain legs
      // merge (a flip's close is its own order; its open may lead an open).
      const members: { fill: ReturnType<typeof decodeLiveSourceFill>; leg: NonNullable<typeof leg> }[] = [];
      for (const id of binding.members ?? []) {
        const [memberRow] = await this.checked(session, db.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.id, id)));
        riskSourceRequire(memberRow, 'live_preparation_source');
        const member = decodeLiveSourceFill(memberRow), legs = canonicalLiveSourceLegs(member), memberLeg = legs.find(v => v.leg === binding.leg);
        riskSourceRequire(member.streamId === fill.streamId && member.coin === fill.coin && memberLeg && memberLeg.sign === leg.sign && legs.length === 1 &&
          member.providerTime > local.mandate.activationCursor!.getTime() && stream.coverageThrough!.getTime() >= member.providerTime, 'live_preparation_source');
        members.push({ fill: member, leg: memberLeg });
      }
      riskSourceRequire(!members.length || local.settings.sizingMode === 'ratio' && (binding.leg === 'open' || canonicalLiveSourceLegs(fill).length === 1), 'live_preparation_source');
      // No leg may already be another order's: a merged leg's work row (if
      // the worker made one) is merged into THIS order's lead and unsent;
      // the lead itself is merged into nothing else.
      if (members.length) {
        const leadId = `${binding.mandateId}|${binding.sourceFillId}|${binding.leg}`;
        const rows = await this.checked(session, db.select().from(copyLiveDispatches).where(and(eq(copyLiveDispatches.mandateId, binding.mandateId),
          inArray(copyLiveDispatches.sourceFillId, [binding.sourceFillId, ...members.map(m => m.fill.id)]))));
        riskSourceRequire(rows.every(row => row.id === leadId ? row.adjustmentId === null || row.adjustmentId === leadId
          : row.adjustmentId === leadId && row.executionKey === null && row.leg === binding.leg), 'live_preparation_claim_conflict');
      }
      return { fill, leg, stream, members };
    });
    mark('preparation_canonical_source');
    const baselineExists = await session.read(async db => {
      const rows = await this.checked(session, db.select().from(copyLivePositionBaselines).where(eq(copyLivePositionBaselines.mandateId, binding.mandateId)));
      return rows.length > 0;
    });
    if (!baselineExists) await session.read(db => this.assertFirstAccount(session, db, local.account.id, network, local.account.address!));
    const manifest = baselineExists ? await session.read(db => loadLiveGenerationManifest(session, db, local, { currentExecutionKey: key, now: started })) : null;
    mark('preparation_generation_manifest');
    // Optional request-owned metadata work starts only after current local
    // authority, canonical source and original generation have been checked.
    this.beforeProviderRead?.(local.wallet.privyWalletId);
    // The leader trades on another network than this copy executes on.
    const crossNetworkSource = local.consent.sourceNetwork !== network;
    const frames = await this.epoch.collect(session, { accountId: binding.accountId, mandateId: binding.mandateId, key, coin: source.fill.coin, leg: binding.leg,
      checkLeverage: binding.leg === 'open',
      includeLeader: !crossNetworkSource && local.settings.sizingMode === 'ratio' && binding.leg === 'open' });
    mark('preparation_provider_collection');
    riskSourceRequire(frames.authorityDigest === riskSourceDigest(local), 'live_risk_local_changed');
    const { market, leader, target: quote } = frames, follower = frames.snapshots[local.accounts.findIndex(a => a.id === binding.accountId)]!;
    await session.scope.assertHeld(); this.fresh(started);
    // An open needs the account's leverage on the coin at most the copy's cap
    // (the risk gate refuses above it; a fresh account sits at the exchange's
    // default 20x). Asked for here, before any journal, nonce or claim.
    if (binding.leg === 'open') {
      const cap = effectiveLeverage(local.limits, local.settings, market.maxLeverage), proof = quote.leverageProofs.find(p => p.coin === market.coin);
      riskSourceRequire(proof, 'live_risk_leverage');
      // The risk gate refuses an open while ANY cross position of the account
      // sits above its coin's cap: that coin's leverage is set down first too.
      const others = follower.positions.flatMap(p => {
        const other = effectiveLeverage(local.limits, local.settings, p.maxLeverage);
        return p.coin !== market.coin && p.leverageType === 'cross' && p.leverage > other ? [{ position: p, leverage: other }] : [];
      });
      // A lower leverage holds more margin (value / leverage). When the
      // account cannot hold it for every position to set down (the order
      // coin's held position too), the open is refused before any update is
      // sent (permanent for the leg, as live_risk_leverage).
      if (others.length) {
        const own = proof.value > cap && follower.positions.some(p => p.coin === market.coin) ? [{ coin: market.coin, leverage: cap }] : [];
        riskSourceRequire(leverageReductionMarginFits(follower, [...own, ...others.map(v => ({ coin: v.position.coin, leverage: v.leverage }))]),
          'live_risk_leverage_margin');
      }
      if (proof.value > cap) throw new LiveLeverageUpdateRequired(market.coin, market.asset, proof.value, cap);
      const first = others[0];
      if (first) throw new LiveLeverageUpdateRequired(first.position.coin, first.position.asset, first.position.leverage, first.leverage);
    }
    // A leader's open on another network is priced on the execution network but
    // checked against the source network's mid and sized by the leader's capital
    // there (as paper copies). A leader on the execution network needs neither.
    let sourceReference: LiveSourceReferenceV1 | null = null;
    if (crossNetworkSource && binding.leg === 'open') {
      riskSourceRequire(this.reference && this.reference.network === local.consent.sourceNetwork && this.options.maxSourceDeviationBps !== undefined, 'live_source_reference_unconfigured');
      const read = await this.reference.read(local.consent.leaderAddress, source.fill.coin, local.settings.sizingMode === 'ratio');
      await session.scope.assertHeld(); this.fresh(started);
      sourceReference = { network: local.consent.sourceNetwork, leaderAddress: local.consent.leaderAddress, leaderEquity: read.leaderEquity, leaderEquityObservedAt: read.leaderEquityObservedAt,
        midPrice: read.midPrice, midObservedAt: read.midObservedAt, maxDeviationBps: Dec.from(this.options.maxSourceDeviationBps).toString() };
      assertLiveSourcePrice(quote.quote.midPrice, sourceReference);
    }
    const oldest = Math.min(frames.oldest, market.observedAt, quote.earliestObservedAt, follower.observedAt, follower.coverage.earliestProviderTime, ...follower.dexes.map(v => v.providerTime),
      ...(leader ? [leader.observedAt, leader.coverage.earliestProviderTime, ...leader.dexes.map(v => v.providerTime)] : []));
    this.fresh(oldest);
    const planningAt = this.now();
    const baseline = manifest?.baseline ?? captureLivePositionBaseline({ mandateId: binding.mandateId, accountId: local.account.id, strategyId: local.strategy.id,
      firstExecutionKey: key, network, accountAddress: local.account.address! }, follower, planningAt);
    const currentManifest: LiveGenerationManifestV1 = manifest ?? { version: 1, accountId: local.account.id, mandateId: binding.mandateId, checkedAt: planningAt,
      baseline, journals: [], receipts: [], ledger: [], scan: null, conflicts: [], accountState: null, carry: [] };
    const legId = liveSourceLegId(binding.mandateId, source.fill.id, binding.leg);
    let carry = currentManifest.carry.find(v => v.coin === source.fill.coin);
    const seedCarry = !carry;
    if (!carry) {
      riskSourceRequire(!currentManifest.journals.some(v => v.journal.record && (v.journal.record as unknown as LiveExecutionRecord).market?.coin === source.fill.coin), 'live_preparation_carry_missing');
      // Seeded at the manifest's own check time, not planningAt: a later time
      // fails the proof's updatedAt <= checkedAt for a coin the copy has not
      // traded yet (Stage mainnet 2026-10-12). The row is stored with the same time.
      carry = { mandateId: binding.mandateId, coin: source.fill.coin, carry: '0', revision: 1, updatedAt: new Date(currentManifest.checkedAt).toISOString() };
    }
    const seeded: LiveGenerationManifestV1 = { ...currentManifest, carry: seedCarry ? [...currentManifest.carry, carry] : currentManifest.carry };
    const projection = projectLiveGenerationPositions({ identity: { mandateId: binding.mandateId, mandateRevision: local.mandate.revision, accountId: local.account.id, userId: local.account.userId,
      strategyId: local.strategy.id, network, accountAddress: local.account.address!, authorizationId: local.grant.id, settingsDigest: local.consent.settingsDigest,
      leaderAddress: local.consent.leaderAddress, direction: local.settings.direction }, ...liveGenerationProofsByDigest(seeded), snapshot: follower, currentExecutionKey: key, now: planningAt });
    const positionSize = projection.positions[source.fill.coin] ?? '0';
    // O10b: an open of a coin the generation proves flat while its carry still
    // owes something (a close emptied it without resetting it: reconcile,
    // owner, or one cancelled before its reset) is sized from carry 0. The
    // reset is the carry change the closer's would be (revision + 1, an
    // updatedAt never earlier: the manifest's own check time, at or after the
    // row's, which the projection proved) and is written in the journal
    // transaction below, only while nothing else relies on the old carry.
    // The projection already refuses any other journal of the generation
    // still in flight; a close plans nothing on a flat follower, so only an
    // open resets.
    const owedCarry = binding.leg === 'open' && Dec.from(positionSize).isZero && Dec.from(carry.carry).isPositive ? carry : null;
    if (owedCarry) {
      const at = Math.max(Date.parse(owedCarry.updatedAt), currentManifest.checkedAt);
      riskSourceRequire(Number.isSafeInteger(owedCarry.revision + 1) && at <= currentManifest.checkedAt, 'live_preparation_generation_changed');
      carry = { ...owedCarry, carry: '0', revision: owedCarry.revision + 1, updatedAt: new Date(at).toISOString() };
    }
    const reset = carry;
    const withCarry: LiveGenerationManifestV1 = owedCarry ? { ...seeded, carry: seeded.carry.map(row => row.coin === reset.coin ? reset : row) } : seeded;
    const closeLeg = canonicalLiveSourceLegs(source.fill).find(v => v.leg === 'close'), dependsOn = binding.leg === 'open' && closeLeg ? liveSourceLegId(binding.mandateId, source.fill.id, 'close') : null;
    // The close leg's current order (its latest attempt), not an earlier attempt released as never sent.
    const dependency = dependsOn ? withCarry.journals.find(v => v.leg?.id === dependsOn && v.leg.executionKey === v.journal.key) : null;
    // A fixed open rounded up to the order minimum stays within the deployment's per-trade maximum.
    const fixedMax = binding.leg === 'open' && local.settings.sizingMode === 'fixed' ? liveDeploymentPolicy()?.caps.fixedPerTradeUsd?.max : undefined;
    // TEST ONLY: a ratio open under the minimum is raised to it (COPY_LIVE_TEST_MIN_FLOOR_MAX_USD).
    const ratioFloor = binding.leg === 'open' && local.settings.sizingMode === 'ratio' ? liveDeploymentPolicy()?.caps.testMinFloorMaxUsd : undefined;
    const sizing: LiveSourceSizingEnvelopeV1 = { version: 1, basis: { version: 1, mandateId: binding.mandateId, mandateRevision: local.mandate.revision,
      settingsDigest: local.consent.settingsDigest, sourceFillId: source.fill.id, sourceDigest: source.fill.sourceDigest, network, accountAddress: local.account.address!,
      coin: source.fill.coin, leg: binding.leg, direction: local.settings.direction, sizingMode: local.settings.sizingMode, budgetUsd: local.consent.budgetUsd,
      perTradeUsd: local.settings.perTradeUsd === null ? null : Dec.from(local.settings.perTradeUsd).toString(),
      ...(fixedMax !== undefined ? { fixedMaxUsd: Dec.from(String(fixedMax)).toString() } : {}),
      ...(ratioFloor !== undefined ? { ratioFloorMaxUsd: Dec.from(String(ratioFloor)).toString() } : {}), exchangeMinimum: true, market,
      quote: { midPrice: quote.quote.midPrice, slippageBps: Dec.min(Dec.from(this.options.slippageBps), Dec.from(local.limits.maxSlippageBps)).toString(), observedAt: quote.quote.observedAt, completedAt: quote.completedAt, sourceDigest: quote.quote.sourceDigest },
      follower: { network, accountAddress: follower.accountAddress, equity: follower.perpEquity, positionSize, observedAt: follower.observedAt, completedAt: follower.completedAt,
        sourceDigest: follower.sourceDigest, snapshotDigest: followerReceiptDigestV1(follower), positionsDigest: projection.positionsDigest },
      leader: leader ? { network, accountAddress: leader.accountAddress, equity: leader.perpEquity, observedAt: leader.observedAt, completedAt: leader.completedAt, sourceDigest: leader.sourceDigest, snapshotDigest: followerReceiptDigestV1(leader) } : null,
      generation: { mandateId: binding.mandateId, baselineDigest: projection.baselineDigest, receiptManifestDigest: projection.receiptManifestDigest, positionsDigest: projection.positionsDigest, positionSize },
      carry: { amount: carry.carry, revision: carry.revision }, fixedTradeClaim: binding.leg === 'open' && local.settings.sizingMode === 'fixed',
      settledDependency: dependsOn && dependency?.evidence?.settlementDigest ? { legId: dependsOn, certificateDigest: dependency.evidence.settlementDigest } : null,
      ...(sourceReference ? { sourceReference } : {}),
      ...(source.members.length ? { merged: { members: [{ fill: source.fill, leg: source.leg }, ...source.members]
        .sort((a, b) => compareMergedLegs({ providerTime: a.fill.providerTime, sourceFillId: a.fill.id }, { providerTime: b.fill.providerTime, sourceFillId: b.fill.id }))
        .map(({ fill, leg }) => ({ sourceFillId: fill.id, sourceDigest: fill.sourceDigest, providerTime: fill.providerTime, sign: leg.sign, size: leg.size, px: fill.px, fraction: leg.fraction })) } } : {}) },
      // Settled orders' proofs by digest only (compactLiveGenerationManifest):
      // the planner reads them from this manifest, a replay from SQL.
      observations: { follower, leader, quote, generationManifest: compactLiveGenerationManifest(withCarry) } };
    // Frozen, so the planner's three checks below plan the very same envelope
    // and proofs: the later two reuse the first one's generation projection
    // (re-asserting its equivalence and the checks that depend on the time).
    freezeLiveReservation(sizing);
    const settlementProofs = freezeLiveReservation(liveSettlementProofsOf(withCarry)), projectionMemo = new LiveGenerationProjectionMemo();
    // The planner verifies every merged leg against its persisted fill.
    const members = source.members.map(member => member.fill);
    const plan = planLiveSourceOrder({ mandate: local.mandate, settings: local.settings, fill: source.fill, leg: source.leg, sizingBasis: sizing,
      now: planningAt, limits: local.limits, currentExecutionKey: key, ...(members.length ? { members } : {}), settlementProofs, projectionMemo });
    // A merged open below the exchange minimum is refused here, before any
    // journal or nonce claims its identity, so its legs can keep accumulating
    // (a single leg keeps the risk gate's refusal after its journal).
    if (source.members.length && !plan.order.reduceOnly && Dec.from(plan.order.size).mul(plan.order.limitPrice).lt(minOrderNotional(local.limits)))
      throw new LiveBoundaryError('below_min_notional');
    const intent: LiveOrderIntent = { authorizationId: local.grant.id, userId: local.account.userId, strategyId: local.strategy.id, walletId: local.wallet.privyWalletId,
      network, accountAddress: address(local.account.address!), cloid, asset: plan.order.asset, side: plan.order.side, size: plan.order.size, limitPrice: plan.order.limitPrice,
      sizeDecimals: plan.order.sizeDecimals, timeInForce: plan.order.timeInForce, reduceOnly: plan.order.reduceOnly, market,
      // A zero fee attaches no builder code (nothing to approve or collect).
      ...(local.consent.builderAddress && local.consent.builderMaxFeeTenthsOfBps > 0 ? { builder: { address: local.consent.builderAddress, feeTenthsBps: local.consent.builderMaxFeeTenthsOfBps, approvedMaxFeeTenthsBps: local.consent.builderMaxFeeTenthsOfBps } } : {}) };
    const action = buildOrderAction(intent), fingerprint = intentFingerprint(intent, action);
    mark('preparation_sizing_plan');
    const record = await session.transaction(async tx => {
      // Round trips (each ~8 ms on Stage, all inside the order's evidence
      // window): statements whose parameters are already known go out
      // together (pipelined; executed in this order) in three batches, and
      // every result is checked in the original order before anything that
      // depends on it, and all of them before COMMIT. A write sent before an
      // earlier check fails is this transaction's own and rolls back with it.
      const sent = <T>(work: Promise<T>): Promise<T> => { void work.catch(() => {}); return work; };
      // 1. The current authority; the generation as of it (read with the
      // earlier authority's account and mandate: the digest check below
      // requires the two authorities equal before the generation is used);
      // the source fill.
      const currentWork = sent(loadLivePreparationAuthority(session, tx, binding, this.now()));
      const finalWork = manifest ? sent(loadLiveGenerationManifest(session, tx, local, { currentExecutionKey: key, now: started })) : undefined;
      const firstAccountWork = manifest ? undefined : sent(this.assertFirstAccount(session, tx, local.account.id, network, local.account.address!));
      const currentFillWork = sent(this.checked(session, tx.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.id, source.fill.id))));
      const current = await currentWork;
      riskSourceRequire(riskSourceDigest(current) === riskSourceDigest(local), 'live_risk_local_changed');
      if (manifest) {
        const final = await finalWork!;
        // Both are the loader's canonical JSON (no undefined, Date or -0), for
        // which deep equality is canonical-digest equality, without hashing
        // every settled proof twice.
        riskSourceRequire(isDeepStrictEqual(final, manifest), 'live_preparation_generation_changed');
      } else await firstAccountWork;
      const now = this.now(), authorization = assertWalletAuthorization(current.currentAuthorization, intent, now);
      planLiveSourceOrder({ mandate: current.mandate, settings: current.settings, fill: source.fill, leg: source.leg, sizingBasis: sizing, now, limits: current.limits, currentExecutionKey: key, ...(members.length ? { members } : {}), settlementProofs, projectionMemo });
      const [currentFill] = await currentFillWork;
      riskSourceRequire(currentFill && decodeLiveSourceFill(currentFill).sourceDigest === source.fill.sourceDigest, 'live_preparation_source');
      // 2. The carry, the legs and their claims, the order's leg locked, the
      // signer's nonce.
      const seedWork = seedCarry ? sent(this.checked(session, tx.insert(copyLiveReductionCarry).values({ mandateId: binding.mandateId, coin: source.fill.coin, carry: '0', revision: 1, updatedAt: new Date(carry.updatedAt) }))) : undefined;
      // The row is still the one the (unchanged) manifest read, and no other
      // journal of this generation and coin is prepared, submitting, unknown
      // or resting, nor a reservation of it unreleased: their sizing basis
      // names the old carry, which settlement, the risk gate and an
      // unattempted release require unchanged. Otherwise nothing is reset
      // or journaled and the leg is tried again (as a changed generation).
      const resetWork = owedCarry ? sent(this.checked(session, tx.update(copyLiveReductionCarry).set({ carry: reset.carry, revision: reset.revision, updatedAt: new Date(reset.updatedAt) })
        .where(and(eq(copyLiveReductionCarry.mandateId, binding.mandateId), eq(copyLiveReductionCarry.coin, source.fill.coin), eq(copyLiveReductionCarry.revision, owedCarry.revision),
          eq(copyLiveReductionCarry.carry, owedCarry.carry),
          sql`not exists (select 1 from ${copyLiveIntentProvenance} p join ${copyLiveExecutions} e on e.key = p.key
            join ${copyLiveSignalLegs} l on l.id = p.leg_id join ${copyLiveSourceFills} f on f.id = l.source_fill_id
            where p.mandate_id = ${binding.mandateId} and f.coin = ${source.fill.coin} and e.state in ('prepared', 'submitting', 'unknown', 'resting'))`,
          sql`not exists (select 1 from ${copyLiveIntentProvenance} p join ${copyLiveRiskReservations} r on r.key = p.key
            where p.mandate_id = ${binding.mandateId} and r.coin = ${source.fill.coin} and r.state <> 'released')`))
        .returning({ mandateId: copyLiveReductionCarry.mandateId }))) : undefined;
      const legWorks: Promise<unknown>[] = [];
      for (const canonical of [...canonicalLiveSourceLegs(source.fill)].sort((a, b) => a.leg === b.leg ? 0 : a.leg === 'close' ? -1 : 1)) {
        const id = liveSourceLegId(binding.mandateId, source.fill.id, canonical.leg), dependencyId = canonical.leg === 'open' && closeLeg ? liveSourceLegId(binding.mandateId, source.fill.id, 'close') : null;
        legWorks.push(sent(this.checked(session, tx.insert(copyLiveSignalLegs).values({ id, mandateId: binding.mandateId, sourceFillId: source.fill.id, ...canonical, dependsOnId: dependencyId, createdAt: new Date(now), updatedAt: new Date(now) }).onConflictDoNothing())));
      }
      // The merged legs are claimed by this order: planned, then skipped (never
      // sent on their own); one already claimed elsewhere refuses the merge.
      const memberWorks = source.members.map(member => {
        const id = liveSourceLegId(binding.mandateId, member.fill.id, member.leg.leg);
        return { member,
          current: sent(this.checked(session, tx.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.id, member.fill.id)))),
          inserted: sent(this.checked(session, tx.insert(copyLiveSignalLegs).values({ id, mandateId: binding.mandateId, sourceFillId: member.fill.id, ...member.leg, dependsOnId: null, createdAt: new Date(now), updatedAt: new Date(now) }).onConflictDoNothing())),
          skipped: sent(this.checked(session, tx.update(copyLiveSignalLegs).set({ state: 'skipped', revision: sql`${copyLiveSignalLegs.revision} + 1`, updatedAt: new Date(now) })
            .where(and(eq(copyLiveSignalLegs.id, id), eq(copyLiveSignalLegs.state, 'planned'), sql`${copyLiveSignalLegs.executionKey} is null`)).returning({ id: copyLiveSignalLegs.id }))) };
      });
      const legWork = sent(this.checked(session, tx.select().from(copyLiveSignalLegs).where(eq(copyLiveSignalLegs.id, legId)).for('update')));
      // A later attempt: the previous one is terminal and released as never
      // sent (its request never began), with no fill, oid or evidence of one.
      const previousWork = previousKey ? sent(this.checked(session, tx.select({ journal: copyLiveExecutions, reservation: copyLiveRiskReservations,
        hasReceipt: sql<boolean>`exists(select 1 from ${copyFollowerReceipts} where ${copyFollowerReceipts.executionKey} = ${previousKey})`,
        hasEvidenceOid: sql<boolean>`exists(select 1 from copy_live_execution_evidence e where e.key = ${previousKey} and e.exchange_order_id is not null)` })
        .from(copyLiveExecutions).innerJoin(copyLiveRiskReservations, eq(copyLiveRiskReservations.key, copyLiveExecutions.key)).where(eq(copyLiveExecutions.key, previousKey)))) : undefined;
      const nonceWork = sent(allocateSignerNonce(tx, network, authorization.signerAddress, now, query => this.checked(session, query), true));
      if (seedWork) await seedWork;
      if (resetWork) riskSourceRequire((await resetWork).length === 1, 'live_preparation_generation_changed');
      for (const work of legWorks) await work;
      for (const { member, current: memberRow, inserted, skipped } of memberWorks) {
        const [currentMember] = await memberRow;
        riskSourceRequire(currentMember && decodeLiveSourceFill(currentMember).sourceDigest === member.fill.sourceDigest, 'live_preparation_source');
        await inserted;
        riskSourceRequire((await skipped).length === 1, 'live_preparation_claim_conflict');
      }
      const [leg] = await legWork;
      if (previousWork) {
        const [previous] = await previousWork;
        riskSourceRequire(previous && isDefinitelyUnsent(decodeLiveExecutionRow(previous.journal)) && previous.reservation.state === 'released' &&
          previous.reservation.releaseReason === 'expired_unplaced' && previous.reservation.exchangeOrderId === null && previous.hasReceipt === false &&
          previous.hasEvidenceOid === false, 'live_preparation_claim_conflict');
      }
      riskSourceRequire(leg && (attempt === 0 ? leg.state === 'planned' && leg.executionKey === null : leg.state === 'skipped' && leg.executionKey === previousKey) && leg.mandateId === binding.mandateId && leg.sourceFillId === source.fill.id &&
        leg.tradeKey === source.leg.tradeKey && leg.sign === source.leg.sign && leg.size === source.leg.size && leg.fraction === source.leg.fraction && leg.dependsOnId === plan.dependsOnLegId, 'live_preparation_claim_conflict');
      const nonce = await nonceWork;
      riskSourceRequire(Number.isSafeInteger(nonce) && nonce >= now && nonce <= now + 30000, 'nonce_clock_skew');
      // 3. The journal, the first baseline, the leg's claim, the provenance.
      const saved: LiveExecutionRecord = { key, fingerprint, authorization, action, market, nonce, expiresAfter: now + 60000, state: 'prepared', createdAt: now, updatedAt: now };
      const journalWork = sent(this.checked(session, tx.insert(copyLiveExecutions).values({ key, network, accountAddress: local.account.address!, signerAddress: authorization.signerAddress,
        cloid, nonce, userId: local.account.userId, strategyId: local.strategy.id, state: 'prepared', record: saved as unknown as Record<string, unknown>, updatedAt: new Date(now) })));
      const baselineWork = manifest ? undefined : sent(this.checked(session, tx.insert(copyLivePositionBaselines).values({ mandateId: baseline.mandateId, firstExecutionKey: key, accountId: baseline.accountId, strategyId: baseline.strategyId,
        network: baseline.network, accountAddress: baseline.accountAddress, observedAt: new Date(baseline.observedAt), completedAt: new Date(baseline.completedAt), createdAt: new Date(baseline.createdAt),
        sourceDigest: baseline.sourceDigest, snapshotDigest: baseline.snapshotDigest, baselineDigest: baseline.baselineDigest, record: baseline as unknown as Record<string, unknown>, producerVersion: 1 })));
      const claimWork = sent(this.checked(session, tx.update(copyLiveSignalLegs).set({ executionKey: key, state: 'prepared', fixedTradeClaim: plan.fixedTradeClaim, revision: leg.revision + 1, updatedAt: new Date(now) })
        .where(and(eq(copyLiveSignalLegs.id, legId), eq(copyLiveSignalLegs.revision, leg.revision), previousKey
          ? and(eq(copyLiveSignalLegs.state, 'skipped'), eq(copyLiveSignalLegs.executionKey, previousKey)) : eq(copyLiveSignalLegs.state, 'planned'))).returning({ id: copyLiveSignalLegs.id })));
      const provenanceWork = sent(this.checked(session, tx.insert(copyLiveIntentProvenance).values({ key, legId, mandateId: binding.mandateId, mandateRevision: current.mandate.revision, sourceDigest: source.fill.sourceDigest,
        settingsDigest: current.consent.settingsDigest, fingerprint, plannerVersion: 1, intent: intent as unknown as Record<string, unknown>, sizingBasis: sizing as unknown as Record<string, unknown>,
        sizingBasisDigest: riskSourceDigest(sizing), admittedAt: new Date(now), attempt })));
      await journalWork;
      if (baselineWork) await baselineWork;
      riskSourceRequire((await claimWork).length === 1, 'live_preparation_claim_conflict');
      await provenanceWork;
      await session.scope.assertHeld(); this.fresh(started);
      planLiveSourceOrder({ mandate: current.mandate, settings: current.settings, fill: source.fill, leg: source.leg, sizingBasis: sizing, now: this.now(), limits: current.limits, currentExecutionKey: key, ...(members.length ? { members } : {}), settlementProofs, projectionMemo });
      this.fresh(oldest);
      return saved;
    }, { readsFirst: true });
    mark('preparation_journal_transaction');
    session.scope.assertFresh();
    this.fresh(started); this.fresh(oldest);
    return { intent: structuredClone(intent), record: structuredClone(record) };
  }
  private async assertFirstAccount(session: LiveRiskDatabaseSession, db: DbExecutor, accountId: string, network: HyperliquidNetwork, accountAddress: string): Promise<void> {
    const history = await this.checked(session, db.select({ key: copyLiveExecutions.key }).from(copyLiveExecutions).where(and(eq(copyLiveExecutions.network, network), eq(copyLiveExecutions.accountAddress, accountAddress))).limit(1));
    const receipts = await this.checked(session, db.select({ key: copyFollowerReceipts.key }).from(copyFollowerReceipts).where(eq(copyFollowerReceipts.accountId, accountId)).limit(1));
    const liabilities = await this.checked(session, db.select({ key: copyLiveRiskReservations.key }).from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.accountId, accountId)).limit(1));
    if (history.length || receipts.length || liabilities.length) throw new LiveBoundaryError('live_preparation_baseline_missing');
  }
}
