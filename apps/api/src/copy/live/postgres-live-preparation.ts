import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { copyLiveDispatches, copyLiveExecutions, copyLiveIntentProvenance, copyLiveSignalLegs, copyLiveSourceFills, copyLiveSourceStreams,
  copyLivePositionBaselines, copyLiveReductionCarry, copyFollowerReceipts, copyLiveRiskReservations } from '@trading-dashboard/shared/database';
import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import type { DbExecutor } from '../../db/unit-of-work.js';
import { allocateSignerNonce } from '../signer-nonce.js';
import { Dec } from '../../common/decimal/dec.js';
import { assertOriginalLiveRiskSession, type LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { loadLivePreparationAuthority, riskSourceDigest, riskSourceRequire } from './postgres-live-risk-authority.js';
import { loadLiveGenerationManifest } from './postgres-live-generation-manifest.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceLegId } from './copy-live-source-evidence.js';
import { planLiveSourceOrder } from './copy-live-source-planner.js';
import type { LiveSourceSizingEnvelopeV1 } from './copy-live-sizing-evidence.js';
import { projectLiveGenerationPositions, type LiveGenerationManifestV1 } from './copy-live-generation-projection.js';
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
import { LiveLeverageUpdateRequired } from './live-leverage-update.js';
import { liveDeploymentPolicy } from '../live-deployment.js';

export interface LivePreparationBinding {
  readonly accountId: string; readonly mandateId: string; readonly sourceFillId: string; readonly leg: 'open' | 'close';
  /** Other same-coin leader legs this order also carries (one merged follower
   * adjustment, ratio sizing): their source fill ids, each with this leg. */
  readonly members?: readonly string[];
}
export interface LivePreparationOptions extends LiveRiskProviderOptions {
  readonly slippageBps: string;
  /** Largest difference (bps) between the execution network's mid and the
   * source network's at which a leader's open on another network is still
   * mirrored. Required when the source network differs from the execution network. */
  readonly maxSourceDeviationBps?: string;
}
/** Stable economic identity, independent of a worker, quote or retry time. */
export function liveSourceExecutionCloid(mandateId: string, sourceFillId: string, leg: 'open' | 'close'): `0x${string}` {
  return `0x${createHash('sha256').update(JSON.stringify(['live-copy-v1', mandateId, sourceFillId, leg])).digest('hex').slice(0, 32)}`;
}

/** Prepares authority, never signs or submits. All remote observations occur
 * outside SQL; the first baseline, canonical source claim, monotonic nonce,
 * exact intent and provenance commit together on the original connection. */
export class PostgresLivePreparation {
  private readonly options: Readonly<LivePreparationOptions>;
  private readonly epoch: LiveProviderReadEpoch;
  constructor(private readonly observer: HyperliquidLiveAccountObserver, private readonly resolver: HyperliquidLiveMarketResolver,
    private readonly provider: HyperliquidLiveRiskProvider, options: LivePreparationOptions, private readonly now = Date.now, epoch?: LiveProviderReadEpoch,
    private readonly reference?: LiveSourceReferenceReader) {
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
    riskSourceRequire(Number.isSafeInteger(now) && now >= started && now - started <= 5000, 'live_risk_stale');
  }
  async prepare(session: LiveRiskDatabaseSession, supplied: LivePreparationBinding): Promise<{ intent: LiveOrderIntent; record: LiveExecutionRecord }> {
    assertOriginalLiveRiskSession(session);
    const binding = Object.freeze(structuredClone(supplied)), started = this.now();
    riskSourceRequire(binding && ['open', 'close'].includes(binding.leg) && [binding.accountId, binding.mandateId, binding.sourceFillId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 160) &&
      (binding.members === undefined || Array.isArray(binding.members) && binding.members.length >= 1 && binding.members.length < MAX_MERGED_LEGS &&
        binding.members.every(v => typeof v === 'string' && v.length > 0 && v.length <= 160 && v !== binding.sourceFillId) && new Set(binding.members).size === binding.members.length), 'live_preparation_binding');
    const local = await session.read(db => loadLivePreparationAuthority(session, db, binding, started));
    // The execution network: the account's (the authority binds it to the scope).
    const network = local.account.network;
    const cloid = liveSourceExecutionCloid(binding.mandateId, binding.sourceFillId, binding.leg), key = executionKey({ network, accountAddress: address(local.account.address!), cloid });
    const existing = await session.read(async db => {
      const [row] = await this.checked(session, db.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key)));
      if (!row) return null;
      const [provenance] = await this.checked(session, db.select().from(copyLiveIntentProvenance).where(eq(copyLiveIntentProvenance.key, key)));
      riskSourceRequire(provenance && provenance.mandateId === binding.mandateId && provenance.legId === liveSourceLegId(binding.mandateId, binding.sourceFillId, binding.leg), 'live_preparation_conflict');
      const intent = structuredClone(provenance.intent) as unknown as LiveOrderIntent, record = decodeLiveExecutionRow(row);
      riskSourceRequire(executionKey(intent) === key && record.fingerprint === intentFingerprint(intent, buildOrderAction(intent)) && record.fingerprint === provenance.fingerprint, 'live_preparation_conflict');
      await session.scope.assertHeld();
      return { intent, record };
    });
    // An original attempted/expired identity is retained, never re-priced or
    // given another nonce. The executor's reconciliation owns its next step.
    if (existing) return existing;
    const source = await session.read(async db => {
      const [row] = await this.checked(session, db.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.id, binding.sourceFillId)));
      riskSourceRequire(row, 'live_preparation_source');
      const fill = decodeLiveSourceFill(row), [stream] = await this.checked(session, db.select().from(copyLiveSourceStreams).where(eq(copyLiveSourceStreams.id, fill.streamId)));
      riskSourceRequire(stream?.state === 'ready' && stream.network === local.consent.sourceNetwork && stream.leaderAddress === local.consent.leaderAddress &&
        fill.leaderAddress === local.consent.leaderAddress && fill.network === local.consent.sourceNetwork && fill.providerTime > local.mandate.activationCursor!.getTime() &&
        stream.coverageFrom && stream.coverageThrough && stream.coverageDigest && stream.coverageFrom.getTime() <= local.mandate.activationCursor!.getTime() && stream.coverageThrough.getTime() >= fill.providerTime, 'live_preparation_source');
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
    const baselineExists = await session.read(async db => {
      const rows = await this.checked(session, db.select().from(copyLivePositionBaselines).where(eq(copyLivePositionBaselines.mandateId, binding.mandateId)));
      return rows.length > 0;
    });
    if (!baselineExists) await session.read(db => this.assertFirstAccount(session, db, local.account.id, network, local.account.address!));
    const manifest = baselineExists ? await session.read(db => loadLiveGenerationManifest(session, db, local, { currentExecutionKey: key, now: started })) : null;
    // The leader trades on another network than this copy executes on.
    const crossNetworkSource = local.consent.sourceNetwork !== network;
    const frames = await this.epoch.collect(session, { accountId: binding.accountId, mandateId: binding.mandateId, key, coin: source.fill.coin,
      includeLeader: !crossNetworkSource && local.settings.sizingMode === 'ratio' && binding.leg === 'open' });
    riskSourceRequire(frames.authorityDigest === riskSourceDigest(local), 'live_risk_local_changed');
    const { market, leader, target: quote } = frames, follower = frames.snapshots[local.accounts.findIndex(a => a.id === binding.accountId)]!;
    await session.scope.assertHeld(); this.fresh(started);
    // An open needs the account's leverage on the coin at most the copy's cap
    // (the risk gate refuses above it; a fresh account sits at the exchange's
    // default 20x). Asked for here, before any journal, nonce or claim.
    if (binding.leg === 'open') {
      const cap = effectiveLeverage(local.limits, local.settings, market.maxLeverage), proof = quote.leverageProofs.find(p => p.coin === market.coin);
      riskSourceRequire(proof, 'live_risk_leverage');
      if (proof.value > cap) throw new LiveLeverageUpdateRequired(market.coin, market.asset, proof.value, cap);
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
      carry = { mandateId: binding.mandateId, coin: source.fill.coin, carry: '0', revision: 1, updatedAt: new Date(planningAt).toISOString() };
    }
    const withCarry: LiveGenerationManifestV1 = { ...currentManifest, carry: seedCarry ? [...currentManifest.carry, carry] : currentManifest.carry };
    const projection = projectLiveGenerationPositions({ identity: { mandateId: binding.mandateId, mandateRevision: local.mandate.revision, accountId: local.account.id, userId: local.account.userId,
      strategyId: local.strategy.id, network, accountAddress: local.account.address!, authorizationId: local.grant.id, settingsDigest: local.consent.settingsDigest,
      leaderAddress: local.consent.leaderAddress, direction: local.settings.direction }, manifest: withCarry, snapshot: follower, currentExecutionKey: key, now: planningAt });
    const closeLeg = canonicalLiveSourceLegs(source.fill).find(v => v.leg === 'close'), dependsOn = binding.leg === 'open' && closeLeg ? liveSourceLegId(binding.mandateId, source.fill.id, 'close') : null;
    const dependency = dependsOn ? withCarry.journals.find(v => v.leg?.id === dependsOn) : null;
    const positionSize = projection.positions[source.fill.coin] ?? '0';
    // A fixed open rounded up to the order minimum stays within the deployment's per-trade maximum.
    const fixedMax = binding.leg === 'open' && local.settings.sizingMode === 'fixed' ? liveDeploymentPolicy()?.caps.fixedPerTradeUsd?.max : undefined;
    const sizing: LiveSourceSizingEnvelopeV1 = { version: 1, basis: { version: 1, mandateId: binding.mandateId, mandateRevision: local.mandate.revision,
      settingsDigest: local.consent.settingsDigest, sourceFillId: source.fill.id, sourceDigest: source.fill.sourceDigest, network, accountAddress: local.account.address!,
      coin: source.fill.coin, leg: binding.leg, direction: local.settings.direction, sizingMode: local.settings.sizingMode, budgetUsd: local.consent.budgetUsd,
      perTradeUsd: local.settings.perTradeUsd === null ? null : Dec.from(local.settings.perTradeUsd).toString(),
      ...(fixedMax !== undefined ? { fixedMaxUsd: Dec.from(String(fixedMax)).toString() } : {}), exchangeMinimum: true, market,
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
      observations: { follower, leader, quote, generationManifest: withCarry } };
    // The planner verifies every merged leg against its persisted fill.
    const members = source.members.map(member => member.fill);
    const plan = planLiveSourceOrder({ mandate: local.mandate, settings: local.settings, fill: source.fill, leg: source.leg, sizingBasis: sizing,
      now: planningAt, limits: local.limits, currentExecutionKey: key, ...(members.length ? { members } : {}) });
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
    const record = await session.transaction(async tx => {
      const current = await loadLivePreparationAuthority(session, tx, binding, this.now());
      riskSourceRequire(riskSourceDigest(current) === riskSourceDigest(local), 'live_risk_local_changed');
      if (manifest) {
        const final = await loadLiveGenerationManifest(session, tx, current, { currentExecutionKey: key, now: started });
        riskSourceRequire(riskSourceDigest(final) === riskSourceDigest(manifest), 'live_preparation_generation_changed');
      } else await this.assertFirstAccount(session, tx, local.account.id, network, local.account.address!);
      const now = this.now(), authorization = assertWalletAuthorization(current.currentAuthorization, intent, now);
      planLiveSourceOrder({ mandate: current.mandate, settings: current.settings, fill: source.fill, leg: source.leg, sizingBasis: sizing, now, limits: current.limits, currentExecutionKey: key, ...(members.length ? { members } : {}) });
      const [currentFill] = await this.checked(session, tx.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.id, source.fill.id)));
      riskSourceRequire(currentFill && decodeLiveSourceFill(currentFill).sourceDigest === source.fill.sourceDigest, 'live_preparation_source');
      if (seedCarry) await this.checked(session, tx.insert(copyLiveReductionCarry).values({ mandateId: binding.mandateId, coin: source.fill.coin, carry: '0', revision: 1, updatedAt: new Date(planningAt) }));
      for (const canonical of [...canonicalLiveSourceLegs(source.fill)].sort((a, b) => a.leg === b.leg ? 0 : a.leg === 'close' ? -1 : 1)) {
        const id = liveSourceLegId(binding.mandateId, source.fill.id, canonical.leg), dependencyId = canonical.leg === 'open' && closeLeg ? liveSourceLegId(binding.mandateId, source.fill.id, 'close') : null;
        await this.checked(session, tx.insert(copyLiveSignalLegs).values({ id, mandateId: binding.mandateId, sourceFillId: source.fill.id, ...canonical, dependsOnId: dependencyId, createdAt: new Date(now), updatedAt: new Date(now) }).onConflictDoNothing());
      }
      // The merged legs are claimed by this order: planned, then skipped (never
      // sent on their own); one already claimed elsewhere refuses the merge.
      for (const member of source.members) {
        const [currentMember] = await this.checked(session, tx.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.id, member.fill.id)));
        riskSourceRequire(currentMember && decodeLiveSourceFill(currentMember).sourceDigest === member.fill.sourceDigest, 'live_preparation_source');
        const id = liveSourceLegId(binding.mandateId, member.fill.id, member.leg.leg);
        await this.checked(session, tx.insert(copyLiveSignalLegs).values({ id, mandateId: binding.mandateId, sourceFillId: member.fill.id, ...member.leg, dependsOnId: null, createdAt: new Date(now), updatedAt: new Date(now) }).onConflictDoNothing());
        const skipped = await this.checked(session, tx.update(copyLiveSignalLegs).set({ state: 'skipped', revision: sql`${copyLiveSignalLegs.revision} + 1`, updatedAt: new Date(now) })
          .where(and(eq(copyLiveSignalLegs.id, id), eq(copyLiveSignalLegs.state, 'planned'), sql`${copyLiveSignalLegs.executionKey} is null`)).returning({ id: copyLiveSignalLegs.id }));
        riskSourceRequire(skipped.length === 1, 'live_preparation_claim_conflict');
      }
      const [leg] = await this.checked(session, tx.select().from(copyLiveSignalLegs).where(eq(copyLiveSignalLegs.id, legId)).for('update'));
      riskSourceRequire(leg?.state === 'planned' && leg.executionKey === null && leg.mandateId === binding.mandateId && leg.sourceFillId === source.fill.id &&
        leg.tradeKey === source.leg.tradeKey && leg.sign === source.leg.sign && leg.size === source.leg.size && leg.fraction === source.leg.fraction && leg.dependsOnId === plan.dependsOnLegId, 'live_preparation_claim_conflict');
      const nonce = await allocateSignerNonce(tx, network, authorization.signerAddress, now, query => this.checked(session, query));
      riskSourceRequire(Number.isSafeInteger(nonce) && nonce >= now && nonce <= now + 30000, 'nonce_clock_skew');
      const saved: LiveExecutionRecord = { key, fingerprint, authorization, action, market, nonce, expiresAfter: now + 60000, state: 'prepared', createdAt: now, updatedAt: now };
      await this.checked(session, tx.insert(copyLiveExecutions).values({ key, network, accountAddress: local.account.address!, signerAddress: authorization.signerAddress,
        cloid, nonce, userId: local.account.userId, strategyId: local.strategy.id, state: 'prepared', record: saved as unknown as Record<string, unknown>, updatedAt: new Date(now) }));
      if (!manifest) await this.checked(session, tx.insert(copyLivePositionBaselines).values({ mandateId: baseline.mandateId, firstExecutionKey: key, accountId: baseline.accountId, strategyId: baseline.strategyId,
        network: baseline.network, accountAddress: baseline.accountAddress, observedAt: new Date(baseline.observedAt), completedAt: new Date(baseline.completedAt), createdAt: new Date(baseline.createdAt),
        sourceDigest: baseline.sourceDigest, snapshotDigest: baseline.snapshotDigest, baselineDigest: baseline.baselineDigest, record: baseline as unknown as Record<string, unknown>, producerVersion: 1 }));
      const claimed = await this.checked(session, tx.update(copyLiveSignalLegs).set({ executionKey: key, state: 'prepared', fixedTradeClaim: plan.fixedTradeClaim, revision: leg.revision + 1, updatedAt: new Date(now) })
        .where(and(eq(copyLiveSignalLegs.id, legId), eq(copyLiveSignalLegs.revision, leg.revision), eq(copyLiveSignalLegs.state, 'planned'))).returning({ id: copyLiveSignalLegs.id }));
      riskSourceRequire(claimed.length === 1, 'live_preparation_claim_conflict');
      await this.checked(session, tx.insert(copyLiveIntentProvenance).values({ key, legId, mandateId: binding.mandateId, mandateRevision: current.mandate.revision, sourceDigest: source.fill.sourceDigest,
        settingsDigest: current.consent.settingsDigest, fingerprint, plannerVersion: 1, intent: intent as unknown as Record<string, unknown>, sizingBasis: sizing as unknown as Record<string, unknown>, admittedAt: new Date(now) }));
      await session.scope.assertHeld(); this.fresh(started);
      planLiveSourceOrder({ mandate: current.mandate, settings: current.settings, fill: source.fill, leg: source.leg, sizingBasis: sizing, now: this.now(), limits: current.limits, currentExecutionKey: key, ...(members.length ? { members } : {}) });
      this.fresh(oldest);
      return saved;
    });
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
