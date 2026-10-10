import { HyperliquidLiveAccountObserver, type LiveAccountSnapshot } from './live-account-observer.js';
import { HyperliquidLiveMarketResolver, type LiveMarketIdentity } from './live-market-resolver.js';
import { liveActiveAssetDataSchema, HyperliquidLiveRiskProvider, type LiveRiskProviderOptions, type LiveRiskProviderProof } from './live-risk-provider.js';
import { assertOriginalLiveRiskSession, type LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { loadLivePreparationAuthority, riskSourceDigest, riskSourceRequire } from './postgres-live-risk-authority.js';
import { freezeLiveReservation } from './live-risk-reservation.js';
import { evidenceFinalCheck, evidenceFirstWave, liveInfoWeights, LiveSharedReads, type LiveInfoBatch } from './live-shared-reads.js';
import type { LiveReserveOptions } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { address } from './wallet-authorization.js';
import { effectiveLeverage } from '../copy-risk.js';
import { LiveLeverageUpdateRequired } from './live-leverage-update.js';
import { beginLiveExecutionTiming, type LiveExecutionTimingHook, type LiveTimingStage } from './live-execution-diagnostics.js';

/** Shared provider reads for an epoch (on the readers' network): the budget the epoch pays
 * its reads from, the info fetch, and the batch transport for each wave. */
export interface LiveEpochSharing {
  /** The order bucket (reserveLive): bounds its own wait, and refuses at once
   * a weight it can never hold. */
  readonly acquire: (weight: number, options?: LiveReserveOptions) => Promise<unknown>;
  readonly fetcher: typeof fetch;
  readonly batch?: LiveInfoBatch;
}

export interface LiveProviderEpochBinding {
  readonly accountId: string;
  readonly mandateId: string;
  readonly key: string;
  readonly coin: string;
  readonly includeLeader?: boolean;
  /** Preparation may lower excessive leverage before the other order reads.
   * A preview never supplies authority for an order. */
  readonly checkLeverage?: boolean;
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
  readonly shared?: LiveSharedReads;
}

/** Actual network observations shared only by one original SQL session and
 * execution identity. This collector cannot import serialized/caller-produced
 * frames. Neither SQL authorization nor exchange approvals are retained here.
 * Every read reloads current SQL authority; original timestamps never move.
 * A failed/expired epoch cannot refresh itself or transfer to another scope. */
export class LiveProviderReadEpoch {
  readonly #epochs = new WeakMap<LiveRiskDatabaseSession, Epoch>();
  readonly #completed = new WeakSet<LiveRiskDatabaseSession>();
  private readonly options: Readonly<LiveRiskProviderOptions>;
  constructor(private readonly observer: HyperliquidLiveAccountObserver,
    private readonly resolver: HyperliquidLiveMarketResolver,
    private readonly provider: HyperliquidLiveRiskProvider,
    options: LiveRiskProviderOptions, private readonly now = Date.now, private readonly sharing?: LiveEpochSharing,
    private readonly onTiming?: LiveExecutionTimingHook) {
    riskSourceRequire(observer instanceof HyperliquidLiveAccountObserver && resolver instanceof HyperliquidLiveMarketResolver &&
      provider instanceof HyperliquidLiveRiskProvider && observer.network === resolver.network && provider.network === resolver.network, 'live_risk_source_unavailable');
    this.options = freezeLiveReservation({ extraRiskBufferBps: options.extraRiskBufferBps,
      restingOrderBuilderFeeCapTenthsBps: options.restingOrderBuilderFeeCapTenthsBps,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  }
  private fresh(at: number): void {
    const now = this.now();
    riskSourceRequire(Number.isSafeInteger(at) && at > 0 && Number.isSafeInteger(now) && now >= at && now - at <= 5000, 'live_risk_stale');
  }
  /** This session's shared reads (after `collect`), so the exchange boundary
   * verifies the market against the same metadata within the same clock. */
  sharedReads(session: LiveRiskDatabaseSession): LiveSharedReads | undefined {
    return this.#epochs.get(session)?.shared;
  }
  /** Only a fulfilled original-session collection can avoid another SQL
   * post-read. This conveys no authority; collect still reloads it each time. */
  hasCompleted(session: LiveRiskDatabaseSession): boolean {
    assertOriginalLiveRiskSession(session);
    return this.#completed.has(session);
  }
  async collect(session: LiveRiskDatabaseSession, supplied: LiveProviderEpochBinding): Promise<LiveProviderEpochFrames> {
    assertOriginalLiveRiskSession(session);
    const binding = Object.freeze(structuredClone(supplied)), started = this.now();
    const mark = beginLiveExecutionTiming(this.resolver.network, 'collect', this.now, this.onTiming);
    riskSourceRequire(binding && [binding.accountId, binding.mandateId, binding.key, binding.coin].every(v => typeof v === 'string' && v.length > 0 && v.length <= 160) &&
      (binding.includeLeader === undefined || typeof binding.includeLeader === 'boolean') &&
      (binding.checkLeverage === undefined || typeof binding.checkLeverage === 'boolean'), 'live_risk_epoch_mismatch');
    // includeLeader is a coverage request, never a new execution identity.
    const bindingDigest = riskSourceDigest({ accountId: binding.accountId, mandateId: binding.mandateId, key: binding.key, coin: binding.coin });
    const previous = this.#epochs.get(session);
    if (previous) riskSourceRequire(previous.bindingDigest === bindingDigest, 'live_risk_epoch_mismatch');
    const authority = await session.read(db => loadLivePreparationAuthority(session, db, binding, this.now()));
    mark('epoch_local_authority');
    this.fresh(started);
    // The readers observe one network: the account's (the scope's).
    riskSourceRequire(authority.account.network === this.resolver.network, 'live_risk_identity');
    const authorityDigest = riskSourceDigest(authority);
    if (previous) {
      riskSourceRequire(previous.authorityDigest === authorityDigest, 'live_risk_local_changed');
      const frames = await previous.frames;
      this.#completed.add(session);
      assertOriginalLiveRiskSession(session); this.fresh(frames.oldest);
      riskSourceRequire(!binding.includeLeader || frames.leader !== null, 'live_risk_epoch_mismatch');
      return frames;
    }
    const shared = this.sharing ? new LiveSharedReads(this.resolver.network, this.sharing.fetcher, this.sharing.batch, this.now, 5000, this.sharing.acquire) : undefined;
    const frames = this.sharing ? this.collectShared(session, binding, authority, authorityDigest, started, this.sharing, shared!, mark) : (async (): Promise<LiveProviderEpochFrames> => {
      const snapshots: LiveAccountSnapshot[] = [];
      const accountsWork = (async () => {
        // The concrete all-venue observer owns an exclusive subscription.
        for (const account of authority.accounts) {
          snapshots.push(await this.observer.observe(account.address!, account.id === binding.accountId ? {} : { unsetup: true }));
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
    this.#epochs.set(session, { bindingDigest, authorityDigest, frames, ...(shared ? { shared } : {}) });
    // Retain failed epochs too: uncertain/expired observations never trigger
    // an implicit second collection or a later timestamp in this execution.
    void frames.catch(() => {});
    const collected = await frames;
    this.#completed.add(session);
    return collected;
  }

  /**
   * One order's evidence with shared reads (P2): the observer, the resolver
   * and the risk providers read the account modes, the dex list, spot and
   * perp metadata, the dex's contexts and the fees once, in waves sent
   * together; the other open coins are read in parallel; the account modes
   * are checked once at the end. The weight of every read is paid before
   * the clock starts (the other coins' once they are known), exactly.
   */
  private async collectShared(session: LiveRiskDatabaseSession, binding: LiveProviderEpochBinding, authority: Awaited<ReturnType<typeof loadLivePreparationAuthority>>,
    authorityDigest: string, started: number, sharing: LiveEpochSharing, shared: LiveSharedReads,
    mark: (stage: LiveTimingStage) => void): Promise<LiveProviderEpochFrames> {
    const target = address(authority.account.address!), users = [...new Set([...authority.accounts.map(a => address(a.address!)),
      ...(binding.includeLeader ? [address(authority.consent.leaderAddress)] : [])])];
    const dex = binding.coin.includes(':') ? binding.coin.split(':')[0]! : '';
    const finalBodies = evidenceFinalCheck(users), first = evidenceFirstWave(users, target, binding.coin);
    // Every read's weight, the final check's too, before the clock starts
    // (liveEvidencePrepaidWeight: what the startup capacity check assumes).
    await shared.pay(liveInfoWeights(first) + liveInfoWeights(finalBodies));
    mark('epoch_budget');
    if (binding.checkLeverage) {
      // Read only indexed market identity and configured leverage first. The
      // same epoch memo serves these reads to the full risk proof if no update
      // is needed. An update ends this scope; its order gets a fresh full epoch.
      await shared.wave([{ type: 'meta', ...(dex ? { dex } : {}) },
        ...(dex ? [{ type: 'perpDexs' }] : []), { type: 'activeAssetData', user: target, coin: binding.coin }]);
      const market = await this.resolver.resolve(binding.coin, shared);
      const active = liveActiveAssetDataSchema.parse(await shared.get({ type: 'activeAssetData', user: target, coin: binding.coin }));
      await session.scope.assertHeld(); this.fresh(started);
      riskSourceRequire(address(active.user) === target && active.coin === market.coin && active.leverage.type === 'cross' &&
        active.leverage.value <= market.maxLeverage, 'live_risk_leverage');
      const cap = effectiveLeverage(authority.limits, authority.settings, market.maxLeverage);
      if (active.leverage.value > cap) throw new LiveLeverageUpdateRequired(market.coin, market.asset, active.leverage.value, cap);
    }
    mark('epoch_leverage_preview');
    const firstWave = shared.wave(first);
    void firstWave.catch(() => {});
    // Every reader's clock is the epoch's: it starts as the first wave goes out.
    await Promise.race([shared.begun, firstWave]);
    const snapshots: LiveAccountSnapshot[] = [];
    // Another copy's account still in setup counts as zero exposure (unsetup).
    const accountsWork = Promise.all(authority.accounts.map(account => this.observer.observe(account.address!, { shared, ...(account.id === binding.accountId ? {} : { unsetup: true }) })));
    void accountsWork.catch(() => {});
    let targetWork: Promise<LiveRiskProviderProof> | undefined, otherWork: Promise<LiveRiskProviderProof[]> | undefined;
    try {
      await firstWave;
      mark('epoch_first_wave');
      await session.scope.assertHeld(); this.fresh(started);
      const market = await this.resolver.resolve(binding.coin, shared);
      await session.scope.assertHeld(); this.fresh(started);
      targetWork = this.provider.observe(target, market, this.options, shared);
      void targetWork.catch(() => {});
      snapshots.push(...await accountsWork);
      await session.scope.assertHeld(); this.fresh(started);
      const current = snapshots[authority.accounts.findIndex(a => a.id === binding.accountId)];
      riskSourceRequire(current, 'live_risk_user_coverage_unproven');
      const leader = binding.includeLeader ? await this.observer.observe(authority.consent.leaderAddress, { shared }) : null;
      await session.scope.assertHeld(); this.fresh(started);
      mark('epoch_account_snapshots');
      const coins = [...new Set([...current.positions.map(p => p.coin), ...current.restingOrders.map(o => o.coin), market.coin])];
      riskSourceRequire(coins.length <= 16, 'live_risk_market_coverage_unbounded');
      const otherCoins = coins.filter(c => c !== market.coin);
      // The other open coins: their own leverage reads, in parallel (one wave).
      const otherBodies = otherCoins.flatMap(coin => {
        const otherDex = coin.includes(':') ? coin.split(':')[0]! : '';
        return [{ type: 'activeAssetData', user: target, coin }, ...(otherDex !== dex ? [{ type: 'meta', ...(otherDex ? { dex: otherDex } : {}) }, { type: 'metaAndAssetCtxs', dex: otherDex }] : [])];
      });
      if (otherBodies.length) await shared.wave(otherBodies);
      otherWork = Promise.all(otherCoins.map(async coin => this.provider.observe(target, await this.resolver.resolve(coin, shared), this.options, shared)));
      void otherWork.catch(() => {});
      const target_ = await targetWork;
      const others = await otherWork;
      await session.scope.assertHeld(); this.fresh(started);
      mark('epoch_other_markets');
      // Nothing changed while it was observed: the account modes and dex
      // list once more, for every reader.
      await shared.unchanged(finalBodies, 'live_account_observation_changed');
      mark('epoch_final_modes');
      const final = await session.read(db => loadLivePreparationAuthority(session, db, binding, this.now()));
      riskSourceRequire(riskSourceDigest(final) === authorityDigest, 'live_risk_local_changed');
      mark('epoch_final_authority');
      const snapshotTimes = (s: LiveAccountSnapshot) => [s.observedAt, s.completedAt, s.coverage.earliestProviderTime, ...s.dexes.map(d => d.providerTime)];
      const oldest = Math.min(started, shared.startedAt, market.observedAt, target_.earliestObservedAt, target_.completedAt,
        ...snapshots.flatMap(snapshotTimes), ...(leader ? snapshotTimes(leader) : []),
        ...others.flatMap(p => [p.market.observedAt, p.earliestObservedAt, p.completedAt]));
      assertOriginalLiveRiskSession(session); this.fresh(oldest);
      return freezeLiveReservation(structuredClone({ market, snapshots, target: target_, others, leader, oldest, authorityDigest }));
    } finally {
      await Promise.allSettled([accountsWork, ...(targetWork ? [targetWork] : []), ...(otherWork ? [otherWork] : [])]);
    }
  }
}
