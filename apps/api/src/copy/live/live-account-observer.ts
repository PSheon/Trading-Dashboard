import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { safeErrorText } from '../../runtime/safe-error-text.js';
import { z } from 'zod';
import { isHyperliquidNetwork, WALLET_NETWORKS, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { HyperliquidAllDexsAccountSource, type LiveAllDexsAccountSource, type LiveAllDexsOrderEvidence } from './live-account-ws-source.js';
export { HyperliquidAllDexsAccountSource, type LiveAllDexsAccountSource, type LiveAllDexsStateEvidence, type LiveAllDexsOrderEvidence, type LiveAllDexsAccountEvidence } from './live-account-ws-source.js';
import { Dec } from '../../common/decimal/dec.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import { boundedLiveRead, MAX_LIVE_PERP_DEXES, LIVE_DEX_NAME, LIVE_PERP_COIN, RESERVE_BOUND_MS } from './live-market-resolver.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';
import { accountModeBodies, liveInfoWeights, type LiveSharedReads } from './live-shared-reads.js';

export interface LiveObservedPosition {
  readonly coin: string; readonly dex: string; readonly asset: number; readonly sizeDecimals: number;
  readonly size: string; readonly entryPrice: string; readonly positionValue: string;
  readonly unrealizedPnl: string; readonly marginUsed: string; readonly leverage: number;
  readonly leverageType: 'cross' | 'isolated'; readonly maxLeverage: number;
  readonly fundingSinceOpen: string; readonly fundingSinceChange: string;
}
export interface LiveObservedRestingOrder {
  readonly coin: string; readonly dex: string; readonly asset: number; readonly oid: string;
  readonly side: 'B' | 'A'; readonly limitPrice: string; readonly remainingSize: string;
  readonly originalSize: string; readonly notionalUsd: string; readonly reduceOnly: boolean;
  readonly timestamp: number; readonly cloid: string | null;
}
export interface LiveObservedDex {
  readonly dex: string; readonly perpDexIndex: number; readonly supported: boolean;
  readonly collateralToken: number; readonly collateralCoin: string; readonly providerTime: number;
  readonly equity: string; readonly rawUsd: string; readonly marginUsed: string; readonly withdrawable: string;
  readonly exposureUsd: string; readonly crossEquity: string; readonly crossMarginUsed: string;
  readonly crossExposureUsd: string; readonly crossMaintenanceMarginUsed: string;
}
export interface LiveAccountSnapshot {
  /** `missing` / `default`: another copy's account not yet funded or set up
   * (`unsetup`), observed with no balance, position or order at all. */
  readonly network: HyperliquidNetwork; readonly accountAddress: string; readonly role: 'user' | 'missing'; readonly accountMode: 'standard';
  readonly accountAbstraction: 'disabled' | 'default'; readonly observedAt: number; readonly completedAt: number;
  readonly sourceDigest: string; readonly collateralToken: number; readonly collateralCoin: 'USDC';
  readonly perpEquity: string; readonly totalMarginUsed: string; readonly withdrawable: string;
  readonly exposureUsd: string; readonly restingExposureUsd: string; readonly grossRestingExposureUsd: string;
  readonly positions: readonly LiveObservedPosition[]; readonly restingOrders: readonly LiveObservedRestingOrder[];
  readonly dexes: readonly LiveObservedDex[];
  readonly coverage: { readonly complete: boolean; readonly balanceComplete: true; readonly orderComplete: boolean;
    readonly listedDexes: readonly string[]; readonly observedOrderDexes: readonly string[];
    readonly unobservedOrderDexes: readonly string[]; readonly earliestProviderTime: number };
}
export interface LiveAccountObservationOptions {
  supportedDexes?: readonly string[];
  /** The order epoch's shared reads: its caller paid their weight, its clock
   * is this observation's, and it checks the account modes once at the end. */
  shared?: LiveSharedReads;
  /** Another copy's account of the owner (never the ordering one): one never
   * funded or still in setup (role `missing`, or abstraction `default`) is
   * accepted when it provably carries no exposure (no balance, position or
   * order anywhere), instead of refusing the owner's orders. */
  unsetup?: boolean;
}
/** Purpose-bound evidence; deliberately lacks the trading account-mode marker. */
export interface SetupAbortFlatObservation {
  readonly purpose: 'setup-abort-return'; readonly snapshot: Omit<LiveAccountSnapshot, 'accountMode'>;
}
/** The observer's REST reads: the account modes and dex list (before and
 * after), spot metadata and every dex's metadata. The all-venue state and
 * orders come over WebSocket (the socket quota, not REST weight). */
const observerBodies = (user: string) => [...accountModeBodies(user), { type: 'perpDexs' }];
export const OBSERVER_REST_WEIGHT = 2 * liveInfoWeights(observerBodies('0x')) + liveInfoWeights([{ type: 'spotMeta' }, { type: 'allPerpMetas' }]);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().max(80).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/).transform((v) => Dec.from(v).toString());
const nonnegative = decimal.refine((v) => Dec.from(v).gte(0));
const positive = decimal.refine((v) => Dec.from(v).gt(0));
const coin = z.string().regex(LIVE_PERP_COIN).max(80);
const summary = z.object({ accountValue: nonnegative, totalNtlPos: nonnegative, totalRawUsd: decimal, totalMarginUsed: nonnegative });
const stateSchema = z.object({ marginSummary: summary, crossMarginSummary: summary,
  crossMaintenanceMarginUsed: nonnegative, withdrawable: nonnegative, time: integer,
  assetPositions: z.array(z.object({ type: z.literal('oneWay'), position: z.object({
    coin, szi: decimal, entryPx: nonnegative, positionValue: nonnegative, unrealizedPnl: decimal,
    marginUsed: nonnegative, maxLeverage: integer.refine((v) => v > 0),
    leverage: z.discriminatedUnion('type', [z.object({ type: z.literal('cross'), value: integer.refine((v) => v > 0) }),
      z.object({ type: z.literal('isolated'), value: integer.refine((v) => v > 0), rawUsd: decimal })]),
    cumFunding: z.object({ allTime: decimal, sinceOpen: decimal, sinceChange: decimal }),
  }) })).max(1024) });
const ordersSchema = z.array(z.object({ coin, side: z.enum(['B', 'A']), limitPx: positive, sz: positive,
  origSz: positive, oid: integer, timestamp: integer, reduceOnly: z.boolean(), isTrigger: z.boolean(),
  isPositionTpsl: z.boolean(), cloid: z.string().regex(/^0x[0-9a-fA-F]{32}$/).nullish() })).max(5000);
const dexSchema = z.array(z.object({ name: z.string().regex(LIVE_DEX_NAME).max(40) }).nullable()).min(1).max(MAX_LIVE_PERP_DEXES);
const metaSchema = z.object({ collateralToken: integer, universe: z.array(z.object({ name: z.string().min(1).max(80),
  szDecimals: integer.refine((v) => v <= 6), maxLeverage: integer.refine((v) => v > 0), isDelisted: z.boolean().optional() })).max(10_000) });
const tokenSchema = z.object({ index: integer, name: z.string().min(1).max(80), isCanonical: z.boolean() });
const spotSchema = z.object({ portfolioMarginEnabled: z.boolean().optional(), balances: z.array(z.object({
  coin: z.string().min(1).max(80), token: integer, total: nonnegative, hold: nonnegative,
})).max(10_000) });
function fail(code: string): never { throw new LiveBoundaryError(code); }
function unique(values: readonly (string | number)[]): void {
  if (new Set(values).size !== values.length) fail('live_account_duplicate_evidence');
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
interface AccountMode { spot: z.infer<typeof spotSchema>; role: 'user' | 'missing'; abstraction: 'disabled' | 'default'; zeroOnly: boolean }
function mode(role: unknown, abstraction: unknown, dexAbstraction: unknown, spot: unknown, unsetup = false, setupAbort = false): AccountMode {
  const parsed = spotSchema.parse(spot);
  if (parsed.portfolioMarginEnabled === true) fail('live_account_unsupported_abstraction');
  if (setupAbort && parsed.balances.some(b => !Dec.from(b.total).isZero || !Dec.from(b.hold).isZero)) fail('live_account_unsupported_abstraction');
  if (setupAbort && z.object({ role: z.literal('user') }).safeParse(role).success && abstraction === 'default' && dexAbstraction === false)
    return { spot: parsed, role: 'user', abstraction: 'default', zeroOnly: false };
  if (z.object({ role: z.literal('user') }).safeParse(role).success && abstraction === 'disabled' && dexAbstraction === false)
    return { spot: parsed, role: 'user', abstraction: 'disabled', zeroOnly: false };
  // Not set up yet (no account at all, or the exchange's default abstraction
  // before the setup disables it): acceptable for another copy only, and only
  // with zero exposure, checked once its balances, positions and orders are read.
  const missing = z.object({ role: z.literal('missing') }).safeParse(role).success;
  // The abort path may finish an original never-funded account only with
  // the same all-zero evidence as unsetup. It gains no trading permission.
  if (setupAbort && missing) unsetup = true;
  if (!(unsetup && missing) && z.object({ role: z.literal('user') }).safeParse(role).success === false) fail('live_account_unsupported_role');
  if (!unsetup) fail('live_account_unsupported_abstraction');
  if (!['disabled', 'default'].includes(String(abstraction)) || ![false, null].includes(dexAbstraction as boolean | null)) fail('live_account_unsupported_abstraction');
  if (parsed.balances.some(b => !Dec.from(b.total).isZero || !Dec.from(b.hold).isZero)) fail(missing ? 'live_account_unsupported_role' : 'live_account_unsupported_abstraction');
  return { spot: parsed, role: missing ? 'missing' : 'user', abstraction: abstraction === 'default' ? 'default' : 'disabled', zeroOnly: true };
}

/** Read-only evidence for dedicated standard accounts on one network. Spot collateral,
 * unified balances, portfolio margin and unobserved venues never become equity.
 * Aggregate values are reporting totals; funding a dex requires its own row. */
export class HyperliquidLiveAccountObserver {
  private readonly aggregateSource: LiveAllDexsAccountSource;
  constructor(readonly network: HyperliquidNetwork, private readonly acquire: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now, private readonly maxAgeMs = 5000,
    aggregateSource?: LiveAllDexsAccountSource, private readonly reservationMaxWaitMs = RESERVE_BOUND_MS) {
    if (!isHyperliquidNetwork(network) || typeof acquire !== 'function' || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 5000 ||
      !Number.isSafeInteger(reservationMaxWaitMs) || reservationMaxWaitMs < 1 || reservationMaxWaitMs > 182_000)
      fail('live_account_invalid_observer');
    this.aggregateSource = aggregateSource ?? new HyperliquidAllDexsAccountSource(now, undefined, network);
  }
  async observe(accountAddress: string, options: LiveAccountObservationOptions = {}): Promise<LiveAccountSnapshot> {
    return this.observeInternal(accountAddress, options, false);
  }
  /** Only pre-generation refunds may inspect funded default abstraction.
   * Every venue and order must be observed, with primary USDC fully withdrawable.
   * This result cannot authorize a trade or reuse the unsetup allocation path. */
  async observeSetupAbortFlat(accountAddress: string): Promise<SetupAbortFlatObservation> {
    const snapshot = await this.observeInternal(accountAddress, {}, true);
    const zero = (v: string) => Dec.from(v).isZero;
    if (!snapshot.coverage.complete || !snapshot.coverage.orderComplete ||
      snapshot.positions.length || snapshot.restingOrders.length || !zero(snapshot.totalMarginUsed) || !zero(snapshot.exposureUsd) ||
      !zero(snapshot.grossRestingExposureUsd) || snapshot.dexes.some(d => !zero(d.marginUsed) || !zero(d.exposureUsd) || !zero(d.crossMarginUsed) ||
        !zero(d.crossExposureUsd) || !zero(d.crossMaintenanceMarginUsed) || (d.dex !== '' && (!zero(d.equity) || !zero(d.rawUsd) || !zero(d.withdrawable)))))
      fail('live_account_setup_abort_not_flat');
    const primary = snapshot.dexes.find(d => d.dex === '');
    if (!primary || primary.collateralCoin !== 'USDC' || !Dec.from(primary.equity).eq(primary.withdrawable) ||
      !Dec.from(primary.rawUsd).eq(primary.withdrawable) || !Dec.from(primary.crossEquity).eq(primary.withdrawable)) fail('live_account_setup_abort_not_withdrawable');
    const { accountMode: _accountMode, ...evidence } = snapshot;
    return frozen({ purpose: 'setup-abort-return', snapshot: evidence });
  }
  private async observeInternal(accountAddress: string, options: LiveAccountObservationOptions, setupAbort: boolean): Promise<LiveAccountSnapshot> {
    try {
      const user = address(accountAddress), shared = options.shared;
      if (shared && shared.network !== this.network) fail('live_account_source_mismatch');
      const allowed = z.array(z.string().regex(LIVE_DEX_NAME).max(40)).max(MAX_LIVE_PERP_DEXES - 1).parse(options.supportedDexes ?? []);
      unique(allowed);
      const supported = new Set(['', ...allowed]);
      // Exactly the REST weight of this observation's reads (account modes and
      // dex list 122 twice, spotMeta 20, allPerpMetas 20; a source without
      // all-venue orders also reads each supported dex's open orders, 20),
      // taken before the clock starts: a budget wait never ages the evidence.
      // The WebSocket reads use the socket quota. An epoch's shared reads
      // were paid by the epoch.
      const restOrders = this.aggregateSource.readAccount === undefined && !this.aggregateSource.readOrders;
      if (!shared) await boundedLiveRead(() => this.acquire(OBSERVER_REST_WEIGHT + (restOrders ? 20 * supported.size : 0)), this.reservationMaxWaitMs);
      const started = shared ? shared.startedAt : this.now();
      this.fresh(started);
      const sources: unknown[] = [];
      const read = async (type: string, weight: number, extra: Record<string, unknown> = {}) => {
        const body = { type, ...extra };
        const remaining = () => { this.fresh(started); return Math.max(1, this.maxAgeMs - (this.now() - started)); };
        void weight; // paid for before the clock
        let value: unknown;
        if (shared) value = await boundedLiveRead(() => shared.get(body), remaining());
        else {
          const response = await boundedLiveRead(() => this.fetcher(WALLET_NETWORKS[this.network].infoUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            redirect: 'error', signal: AbortSignal.timeout(remaining()),
          }), remaining());
          if (!response.ok) fail('live_account_observation_unavailable');
          value = await boundedLiveRead(() => readInfoJson(response, type, (type === 'allPerpMetas' ? 8 : 2) * 1024 * 1024), remaining());
        }
        this.fresh(started);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (row.user !== undefined && (typeof row.user !== 'string' || address(row.user) !== user) || row.network !== undefined && row.network !== this.network)
            fail('live_account_source_mismatch');
        }
        sources.push({ body, value }); return value;
      };
      const accountModes = () => Promise.all([read('userRole', 60, { user }), read('userAbstraction', 20, { user }),
        read('userDexAbstraction', 20, { user }), read('spotClearinghouseState', 2, { user }), read('perpDexs', 20)]);
      const initialWork = Promise.all([accountModes(), read('spotMeta', 20)]);
      // Independent public metadata starts in the first HTTP wave. It remains
      // bounded even if an early account mode rejection prevents its use.
      const metadataRead = read('allPerpMetas', 20);
      void metadataRead.catch(() => {});
      const [initial, rawTokens] = await initialWork;
      const accountMode = mode(...initial.slice(0, 4) as [unknown, unknown, unknown, unknown], options.unsetup === true, setupAbort), spot = accountMode.spot;
      const zeroOnly = accountMode.zeroOnly;
      const tokens = z.object({ tokens: z.array(tokenSchema).max(10_000) }).parse(rawTokens).tokens;
      unique(tokens.map((t) => t.index));
      const usdc = tokens.filter((t) => t.name === 'USDC' && t.isCanonical);
      if (usdc.length !== 1) fail('live_account_unsupported_collateral');
      unique(spot.balances.map((b) => b.token));
      for (const b of spot.balances) {
        if (!tokens.some((t) => t.index === b.token && t.name === b.coin) || Dec.from(b.hold).gt(b.total))
          fail('live_account_invalid_spot_evidence');
      }
      const list = dexSchema.parse(initial[4]);
      if (list[0] !== null) fail('live_account_invalid_dex_evidence');
      unique(list.flatMap((d) => d ? [d.name] : []));
      const venues = [{ dex: '', index: 0 }, ...list.flatMap((d, index) => d ? [{ dex: d.name, index }] : [])];
      if (allowed.some((name) => !venues.some((v) => v.dex === name))) fail('live_account_unobserved_dex');
      const positions: LiveObservedPosition[] = [], orders: LiveObservedRestingOrder[] = [];
      const dexes: LiveObservedDex[] = [];
      let combinedOrders: LiveAllDexsOrderEvidence | undefined;
      const aggregate = async () => {
        this.fresh(started);
        const remaining = () => { this.fresh(started); return Math.max(1, this.maxAgeMs - (this.now() - started)); };
        // Its weight was reserved with the rest, before the clock.
        const combined = this.aggregateSource.readAccount;
        const result = combined ? structuredClone(await boundedLiveRead(() => combined.call(this.aggregateSource,
          user, venues.map((v) => v.dex), remaining()), remaining())) : undefined;
        if (combined && (!result?.state || !result.orders)) fail('live_account_source_mismatch');
        if (result) combinedOrders = result.orders;
        const proof = result?.state ?? structuredClone(await boundedLiveRead(() => this.aggregateSource.read(user, remaining()), remaining()));
        if (proof.network !== this.network || address(proof.accountAddress) !== user) fail('live_account_source_mismatch');
        this.fresh(proof.observedAt); this.fresh(started);
        sources.push({ subscription: { type: 'allDexsClearinghouseState', user }, proof }); return proof.data;
      };
      const [rawMetas, rawAggregate] = await Promise.all([metadataRead, aggregate()]);
      const metas = z.array(metaSchema.nullable()).max(MAX_LIVE_PERP_DEXES).parse(rawMetas);
      const sourceStates = z.object({ clearinghouseStates: z.array(z.tuple([z.string(), z.record(z.unknown())]))
        .max(MAX_LIVE_PERP_DEXES) }).parse(rawAggregate);
      for (const [, row] of sourceStates.clearinghouseStates) {
        if (row.user !== undefined && (typeof row.user !== 'string' || address(row.user) !== user) ||
            row.network !== undefined && row.network !== this.network) fail('live_account_source_mismatch');
      }
      const aggregateStates = z.object({ user: z.string(), clearinghouseStates: z.array(z.tuple([z.string().max(40), stateSchema]))
        .max(MAX_LIVE_PERP_DEXES) }).parse(rawAggregate);
      if (address(aggregateStates.user) !== user) fail('live_account_source_mismatch');
      unique(aggregateStates.clearinghouseStates.map(([dex]) => dex));
      if (metas.length !== list.length || aggregateStates.clearinghouseStates.length !== venues.length ||
          aggregateStates.clearinghouseStates.some(([dex]) => !venues.some((v) => v.dex === dex))) fail('live_account_unobserved_dex');
      const states = new Map(aggregateStates.clearinghouseStates);
      let allOrders: Map<string, unknown[]> | undefined;
      if (combinedOrders || this.aggregateSource.readOrders) {
        const remaining = () => { this.fresh(started); return Math.max(1, this.maxAgeMs - (this.now() - started)); };
        let proof = combinedOrders;
        if (!proof) {
          proof = structuredClone(await boundedLiveRead(() => this.aggregateSource.readOrders!(user, venues.map((v) => v.dex), remaining()), remaining()));
        }
        if (proof.network !== this.network || address(proof.accountAddress) !== user) fail('live_account_source_mismatch');
        this.fresh(proof.observedAt); this.fresh(proof.completedAt);
        if (proof.completedAt < proof.observedAt) fail('live_account_source_mismatch');
        const requested = z.array(z.string()).max(MAX_LIVE_PERP_DEXES).parse(proof.requestedDexes);
        unique(requested);
        const events = z.array(z.object({ dex: z.string(), user: z.string(), observedAt: integer, receivedAt: integer,
          orders: z.array(z.unknown()).max(5000) })).max(MAX_LIVE_PERP_DEXES).parse(proof.venues);
        unique(events.map((e) => e.dex));
        if (requested.length !== venues.length || events.length !== venues.length ||
            requested.some((dex) => !venues.some((v) => v.dex === dex)) || events.some((e) => !requested.includes(e.dex)))
          fail('live_account_unobserved_orders');
        for (const event of events) {
          if (address(event.user) !== user || event.receivedAt < event.observedAt || event.observedAt < proof.observedAt ||
              event.receivedAt > proof.completedAt) fail('live_account_source_mismatch');
          this.fresh(event.observedAt); this.fresh(event.receivedAt);
        }
        allOrders = new Map(events.map((e) => [e.dex, e.orders]));
        sources.push({ subscriptions: { type: 'openOrders', user, dexes: requested }, proof });
      }
      // Real all-venue order evidence closes the coverage gap; a legacy source
      // without it remains explicitly incomplete for unsupported venues.
      for (const venue of venues) {
        const scope = venue.dex ? { dex: venue.dex } : {};
        const meta = metas[venue.index], state = states.get(venue.dex);
        if (!meta || !state) fail('live_account_unobserved_dex');
        const pending = allOrders ? ordersSchema.parse(allOrders.get(venue.dex))
          : supported.has(venue.dex) ? ordersSchema.parse(await read('frontendOpenOrders', 20, { user, ...scope })) : [];
        this.fresh(state.time);
        unique(meta.universe.map((m) => m.name)); unique(state.assetPositions.map((p) => p.position.coin));
        const collateral = tokens.find((t) => t.index === meta.collateralToken);
        if (!collateral) fail('live_account_unsupported_collateral');
        const market = (name: string) => {
          const index = meta.universe.findIndex((m) => m.name === name), found = meta.universe[index];
          if (!found || found.isDelisted || (venue.dex ? !name.startsWith(`${venue.dex}:`) : name.includes(':')))
            fail('live_account_unknown_market');
          return { coin: name, dex: venue.dex, asset: venue.index ? 100_000 + venue.index * 10_000 + index : index,
            sizeDecimals: found.szDecimals };
        };
        for (const { position: p } of state.assetPositions) {
          const identity = market(p.coin);
          if (!Dec.from(p.szi).isZero && (!Dec.from(p.entryPx).gt(0) || !Dec.from(p.positionValue).gt(0)) ||
              p.leverage.value > p.maxLeverage || !Dec.from(p.szi).eq(Dec.from(p.szi).floor(identity.sizeDecimals)))
            fail('live_account_invalid_position');
          positions.push({ ...identity, size: p.szi, entryPrice: p.entryPx, positionValue: p.positionValue,
            unrealizedPnl: p.unrealizedPnl, marginUsed: p.marginUsed, leverage: p.leverage.value,
            leverageType: p.leverage.type, maxLeverage: p.maxLeverage,
            fundingSinceOpen: p.cumFunding.sinceOpen, fundingSinceChange: p.cumFunding.sinceChange });
        }
        for (const o of pending) {
          const identity = market(o.coin);
          if (o.isTrigger || o.isPositionTpsl || Dec.from(o.sz).gt(o.origSz) || o.timestamp > this.now() ||
              !Dec.from(o.sz).eq(Dec.from(o.sz).floor(identity.sizeDecimals))) fail('live_account_unsupported_resting_order');
          orders.push({ coin: o.coin, dex: venue.dex, asset: identity.asset, oid: String(o.oid), side: o.side,
            limitPrice: o.limitPx, remainingSize: o.sz, originalSize: o.origSz,
            notionalUsd: Dec.from(o.sz).mul(o.limitPx).toString(), reduceOnly: o.reduceOnly,
            timestamp: o.timestamp, cloid: o.cloid?.toLowerCase() ?? null });
        }
        const s = state.marginSummary, cross = state.crossMarginSummary;
        const positionSum = (key: 'positionValue' | 'marginUsed', crossOnly = false) => Dec.sum(state.assetPositions
          .filter(({ position }) => !crossOnly || position.leverage.type === 'cross').map(({ position }) => Dec.from(position[key])));
        if (!positionSum('positionValue').eq(s.totalNtlPos) || !positionSum('marginUsed').eq(s.totalMarginUsed) ||
            !positionSum('positionValue', true).eq(cross.totalNtlPos) || !positionSum('marginUsed', true).eq(cross.totalMarginUsed))
          fail('live_account_inconsistent_balances');
        if (Dec.from(cross.totalMarginUsed).gt(s.totalMarginUsed) || Dec.from(cross.totalNtlPos).gt(s.totalNtlPos) ||
            Dec.from(state.withdrawable).gt(s.accountValue)) fail('live_account_inconsistent_balances');
        const active = Object.values(s).some((v) => !Dec.from(v).isZero) || Object.values(cross).some((v) => !Dec.from(v).isZero) ||
          !Dec.from(state.withdrawable).isZero || !Dec.from(state.crossMaintenanceMarginUsed).isZero ||
          state.assetPositions.length > 0 || pending.length > 0;
        if (zeroOnly && active) fail(accountMode.role !== 'user' ? 'live_account_unsupported_role' : 'live_account_unsupported_abstraction');
        if (collateral.index !== usdc[0]!.index && (active || !venue.dex)) fail('live_account_unsupported_collateral');
        if (!supported.has(venue.dex) && active) fail('live_account_unsupported_dex_exposure');
        dexes.push({ dex: venue.dex, perpDexIndex: venue.index, supported: supported.has(venue.dex),
          collateralToken: collateral.index, collateralCoin: collateral.name, providerTime: state.time,
          equity: s.accountValue, rawUsd: s.totalRawUsd, marginUsed: s.totalMarginUsed, withdrawable: state.withdrawable,
          exposureUsd: s.totalNtlPos, crossEquity: cross.accountValue, crossMarginUsed: cross.totalMarginUsed,
          crossExposureUsd: cross.totalNtlPos, crossMaintenanceMarginUsed: state.crossMaintenanceMarginUsed });
      }
      unique(orders.map((o) => o.oid));
      if (orders.length > 5000 || positions.length > 10000) fail('live_account_unbounded_evidence');
      // Nothing changed while it was observed (an epoch checks this once, for
      // every reader, after the last of them).
      if (!shared) {
        const final = await accountModes();
        const finalMode = mode(...final.slice(0, 4) as [unknown, unknown, unknown, unknown], options.unsetup === true, setupAbort);
        if (JSON.stringify(dexSchema.parse(final[4])) !== JSON.stringify(list) || JSON.stringify(finalMode) !== JSON.stringify(accountMode))
          fail('live_account_observation_changed');
      }
      this.fresh(started); for (const d of dexes) this.fresh(d.providerTime);
      const sum = (key: 'equity' | 'marginUsed' | 'withdrawable' | 'exposureUsd') => Dec.sum(dexes.map((d) => Dec.from(d[key]))).toString();
      const unobservedOrderDexes = allOrders ? [] : venues.filter((v) => !supported.has(v.dex)).map((v) => v.dex);
      return frozen({ network: this.network, accountAddress: user, role: accountMode.role, accountMode: 'standard', accountAbstraction: accountMode.abstraction,
        observedAt: started, completedAt: this.now(), sourceDigest: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
        collateralToken: usdc[0]!.index, collateralCoin: 'USDC', perpEquity: sum('equity'), totalMarginUsed: sum('marginUsed'),
        withdrawable: sum('withdrawable'), exposureUsd: sum('exposureUsd'),
        restingExposureUsd: Dec.sum(orders.filter((o) => !o.reduceOnly).map((o) => Dec.from(o.notionalUsd))).toString(),
        grossRestingExposureUsd: Dec.sum(orders.map((o) => Dec.from(o.notionalUsd))).toString(),
        positions: positions.sort((a, b) => a.asset - b.asset), restingOrders: orders,
        dexes, coverage: { complete: unobservedOrderDexes.length === 0, balanceComplete: true, orderComplete: unobservedOrderDexes.length === 0,
          listedDexes: venues.map((v) => v.dex), observedOrderDexes: venues.filter((v) => allOrders || supported.has(v.dex)).map((v) => v.dex),
          unobservedOrderDexes, earliestProviderTime: Math.min(...dexes.map((d) => d.providerTime)) } });
    } catch (error) {
      if (error instanceof LiveBoundaryError && error.code.startsWith('live_account_')) throw error;
      // Still refused as unavailable; what it really was goes to the log.
      new Logger('LiveAccountObserver').warn(`observation unavailable: ${safeErrorText(error)}`);
      fail('live_account_observation_unavailable');
    }
  }
  close(): void { this.aggregateSource.close?.(); }
  private fresh(at: number): void {
    const now = this.now();
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(now) || at < 0 || now < at || now - at > this.maxAgeMs)
      fail('live_account_evidence_expired');
  }
}
