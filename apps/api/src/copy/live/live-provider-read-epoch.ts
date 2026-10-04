import { HyperliquidLiveAccountObserver, type LiveAccountSnapshot } from './live-account-observer.js';
import { HyperliquidLiveMarketResolver, type LiveMarketIdentity } from './live-market-resolver.js';
import { HyperliquidLiveRiskProvider, type LiveRiskProviderOptions, type LiveRiskProviderProof } from './live-risk-provider.js';
import { assertOriginalLiveRiskSession, type LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { loadLivePreparationAuthority, riskSourceDigest, riskSourceRequire } from './postgres-live-risk-authority.js';
import { freezeLiveReservation } from './live-risk-reservation.js';

export interface LiveProviderEpochBinding {
  readonly accountId: string;
  readonly mandateId: string;
  readonly key: string;
  readonly coin: string;
  readonly includeLeader?: boolean;
}
export interface LiveProviderEpochFrames {
  readonly market: LiveMarketIdentity;
  /** Same immutable account order as the current SQL authority. */
  readonly snapshots: readonly LiveAccountSnapshot[];
  readonly target: LiveRiskProviderProof;
  readonly others: readonly LiveRiskProviderProof[];
  readonly leader: LiveAccountSnapshot | null;
  readonly oldest: number;
  readonly authorityDigest: string;
}
interface Epoch {
  readonly bindingDigest: string;
  readonly authorityDigest: string;
  readonly frames: Promise<LiveProviderEpochFrames>;
}

/** Actual network observations shared only by one original SQL session and
 * execution identity. This collector cannot import serialized/caller-produced
 * frames. Neither SQL authorization nor exchange approvals are retained here.
 * Every read reloads current SQL authority; original timestamps never move.
 * A failed/expired epoch cannot refresh itself or transfer to another scope. */
export class LiveProviderReadEpoch {
  readonly #epochs = new WeakMap<LiveRiskDatabaseSession, Epoch>();
  private readonly options: Readonly<LiveRiskProviderOptions>;
  constructor(private readonly observer: HyperliquidLiveAccountObserver,
    private readonly resolver: HyperliquidLiveMarketResolver,
    private readonly provider: HyperliquidLiveRiskProvider,
    options: LiveRiskProviderOptions, private readonly now = Date.now) {
    riskSourceRequire(observer instanceof HyperliquidLiveAccountObserver && resolver instanceof HyperliquidLiveMarketResolver &&
      provider instanceof HyperliquidLiveRiskProvider, 'live_risk_source_unavailable');
    this.options = freezeLiveReservation({ extraRiskBufferBps: options.extraRiskBufferBps,
      restingOrderBuilderFeeCapTenthsBps: options.restingOrderBuilderFeeCapTenthsBps,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  }
  private fresh(at: number): void {
    const now = this.now();
    riskSourceRequire(Number.isSafeInteger(at) && at > 0 && Number.isSafeInteger(now) && now >= at && now - at <= 5000, 'live_risk_stale');
  }
  async collect(session: LiveRiskDatabaseSession, supplied: LiveProviderEpochBinding): Promise<LiveProviderEpochFrames> {
    assertOriginalLiveRiskSession(session);
    const binding = Object.freeze(structuredClone(supplied)), started = this.now();
    riskSourceRequire(binding && [binding.accountId, binding.mandateId, binding.key, binding.coin].every(v => typeof v === 'string' && v.length > 0 && v.length <= 160) &&
      (binding.includeLeader === undefined || typeof binding.includeLeader === 'boolean'), 'live_risk_epoch_mismatch');
    // includeLeader is a coverage request, never a new execution identity.
    const bindingDigest = riskSourceDigest({ accountId: binding.accountId, mandateId: binding.mandateId, key: binding.key, coin: binding.coin });
    const previous = this.#epochs.get(session);
    if (previous) riskSourceRequire(previous.bindingDigest === bindingDigest, 'live_risk_epoch_mismatch');
    const authority = await session.read(db => loadLivePreparationAuthority(session, db, binding, this.now()));
    this.fresh(started);
    const authorityDigest = riskSourceDigest(authority);
    if (previous) {
      riskSourceRequire(previous.authorityDigest === authorityDigest, 'live_risk_local_changed');
      const frames = await previous.frames;
      assertOriginalLiveRiskSession(session); this.fresh(frames.oldest);
      riskSourceRequire(!binding.includeLeader || frames.leader !== null, 'live_risk_epoch_mismatch');
      return frames;
    }
    const frames = (async (): Promise<LiveProviderEpochFrames> => {
      const snapshots: LiveAccountSnapshot[] = [];
      const accountsWork = (async () => {
        // The concrete all-venue observer owns an exclusive subscription.
        for (const account of authority.accounts) {
          snapshots.push(await this.observer.observe(account.address!));
          await session.scope.assertHeld(); this.fresh(started);
        }
        return snapshots;
      })();
      void accountsWork.catch(() => {});
      let targetWork: Promise<LiveRiskProviderProof> | undefined;
      try {
      const market = await this.resolver.resolve(binding.coin);
      await session.scope.assertHeld(); this.fresh(started);
      // Target REST and all-venue WS observation are independent. Start REST
      // as soon as indexed market identity is known, while WS still receives.
      targetWork = this.provider.observe(authority.account.address!, market, this.options);
      void targetWork.catch(() => {});
      await accountsWork;
      const current = snapshots[authority.accounts.findIndex(a => a.id === binding.accountId)];
      riskSourceRequire(current, 'live_risk_user_coverage_unproven');
      const leader = binding.includeLeader ? await this.observer.observe(authority.consent.leaderAddress) : null;
      await session.scope.assertHeld(); this.fresh(started);
      const target = await targetWork;
      await session.scope.assertHeld(); this.fresh(started);
      const coins = [...new Set([...current.positions.map(p => p.coin), ...current.restingOrders.map(o => o.coin), market.coin])];
      riskSourceRequire(coins.length <= 16, 'live_risk_market_coverage_unbounded');
      const others: LiveRiskProviderProof[] = [];
      for (const coin of coins.filter(c => c !== market.coin)) {
        const otherMarket = await this.resolver.resolve(coin);
        await session.scope.assertHeld(); this.fresh(started);
        others.push(await this.provider.observe(authority.account.address!, otherMarket, this.options));
        await session.scope.assertHeld(); this.fresh(started);
      }
      const final = await session.read(db => loadLivePreparationAuthority(session, db, binding, this.now()));
      riskSourceRequire(riskSourceDigest(final) === authorityDigest, 'live_risk_local_changed');
      const snapshotTimes = (s: LiveAccountSnapshot) => [s.observedAt, s.completedAt, s.coverage.earliestProviderTime, ...s.dexes.map(d => d.providerTime)];
      const oldest = Math.min(started, market.observedAt, target.earliestObservedAt, target.completedAt,
        ...snapshots.flatMap(snapshotTimes), ...(leader ? snapshotTimes(leader) : []),
        ...others.flatMap(p => [p.market.observedAt, p.earliestObservedAt, p.completedAt]));
      assertOriginalLiveRiskSession(session); this.fresh(oldest);
      return freezeLiveReservation(structuredClone({ market, snapshots, target, others, leader, oldest, authorityDigest }));
      } finally {
        // Parallel read failures must not tombstone the original SQL scope
        // while its account socket is still cleaning up durable quota leases.
        // The concrete provider readers own bounded network timeouts.
        await Promise.allSettled([accountsWork, ...(targetWork ? [targetWork] : [])]);
      }
    })();
    this.#epochs.set(session, { bindingDigest, authorityDigest, frames });
    // Retain failed epochs too: uncertain/expired observations never trigger
    // an implicit second collection or a later timestamp in this execution.
    void frames.catch(() => {});
    return frames;
  }
}
