import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Dec } from '../../common/decimal/dec.js';
import { readInfoJson } from '../../hyperliquid/response-validation.js';
import type {
  LiveAccountRiskInput,
  LiveRiskLeverageProof,
} from './live-account-risk.js';
import {
  assertMarketIdentity,
  boundedLiveRead,
  LIVE_DEX_NAME,
  MAX_LIVE_PERP_DEXES,
  type LiveMarketIdentity,
} from './live-market-resolver.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';

export interface LiveRiskProviderOptions {
  readonly extraRiskBufferBps: string;
  readonly restingOrderBuilderFeeCapTenthsBps: number;
  readonly timeoutMs?: number;
}
export interface LiveRiskProviderProof {
  readonly network: 'testnet';
  readonly accountAddress: string;
  readonly coin: string;
  readonly dex: string;
  readonly asset: number;
  readonly market: LiveMarketIdentity;
  readonly earliestObservedAt: number;
  readonly completedAt: number;
  readonly sourceDigest: string;
  readonly accountModeProof: {
    readonly network: 'testnet';
    readonly accountAddress: string;
    readonly role: 'user';
    readonly accountAbstraction: 'disabled';
    readonly dexAbstraction: false;
    readonly portfolioMargin: false;
    readonly observedAt: number;
    readonly completedAt: number;
    readonly sourceDigest: string;
  };
  readonly quote: LiveAccountRiskInput['quote'];
  readonly leverageProofs: readonly LiveRiskLeverageProof[];
  /** Effective validator-perp rates from the documented fee formula. These are
   * admission evidence; only actual execution receipts book account cash. */
  readonly fees: LiveAccountRiskInput['fees'] & {
    readonly scope: 'validator_perp';
    readonly calculation: 'documented_fee_formula';
  };
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z
  .string()
  .max(80)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)
  .transform((v) => Dec.from(v).toString());
const nonnegative = decimal.refine((v) => Dec.from(v).gte(0));
const positive = decimal.refine((v) => Dec.from(v).gt(0));
const rate = decimal.refine((v) => Dec.from(v).abs().lte(1));
const fraction = nonnegative.refine((v) => Dec.from(v).lte(1));
const settingsSchema = z.object({
  extraRiskBufferBps: nonnegative.refine((v) => Dec.from(v).lte(10000)),
  restingOrderBuilderFeeCapTenthsBps: integer.refine((v) => v <= 100),
  timeoutMs: integer.refine((v) => v >= 1 && v <= 5000).optional(),
});
const metaSchema = z.object({
  collateralToken: integer,
  universe: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        szDecimals: integer.refine((v) => v <= 6),
        maxLeverage: integer.refine((v) => v > 0),
        isDelisted: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(10000),
});
const contextsSchema = z
  .array(
    z.object({ midPx: nonnegative.nullable().optional(), markPx: nonnegative }),
  )
  .min(1)
  .max(10000);
const targetContextSchema = z.object({ midPx: positive, markPx: positive });
const activeSchema = z.object({
  user: z.string(),
  coin: z.string(),
  leverage: z.discriminatedUnion('type', [
    z.object({ type: z.literal('cross'), value: integer.refine((v) => v > 0) }),
    z.object({
      type: z.literal('isolated'),
      value: integer.refine((v) => v > 0),
      rawUsd: decimal,
    }),
  ]),
  maxTradeSzs: z.tuple([nonnegative, nonnegative]),
  availableToTrade: z.tuple([nonnegative, nonnegative]),
  markPx: positive,
});
const feeSchema = z.object({
  userAddRate: rate,
  userCrossRate: nonnegative.refine((v) => Dec.from(v).lte(1)),
  activeReferralDiscount: fraction,
  trial: z.literal(null),
});
const dexSchema = z
  .array(z.object({ name: z.string().regex(LIVE_DEX_NAME).max(40) }).nullable())
  .min(1)
  .max(MAX_LIVE_PERP_DEXES);
const tokensSchema = z.object({
  tokens: z
    .array(
      z.object({
        index: integer,
        name: z.string().min(1).max(80),
        isCanonical: z.boolean(),
      }),
    )
    .min(1)
    .max(10000),
});
const deny = (code: string): never => {
  throw new LiveBoundaryError(code);
};
function unique(names: readonly (string | number)[]): void {
  if (new Set(names).size !== names.length)
    deny('live_risk_provider_invalid_evidence');
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function mode(values: readonly unknown[]): void {
  if (
    !z.object({ role: z.literal('user') }).safeParse(values[0]).success ||
    values[1] !== 'disabled' ||
    values[2] !== false
  )
    deny('live_risk_provider_unsupported_mode');
  const spot = z
    .object({
      portfolioMarginEnabled: z.boolean().optional(),
      balances: z.array(z.unknown()).max(10000),
    })
    .parse(values[3]);
  if (spot.portfolioMarginEnabled === true)
    deny('live_risk_provider_unsupported_mode');
}

/** The account modes twice (userRole 60, userAbstraction 20,
 * userDexAbstraction 20, spotClearinghouseState 2: before and after the
 * rest), and metaAndAssetCtxs, activeAssetData, userFees, perpDexs and
 * spotMeta 20 each. */
const RISK_PROVIDER_WEIGHT = 304;
/** Uncached fixed-testnet REST proofs. Target activeAssetData reads configured
 * leverage even without a position. No credentials, WS, signatures or actions.
 * Named dex effective-fee settings remain unproven and cannot yield a proof. */
export class HyperliquidLiveRiskProvider {
  readonly network = 'testnet' as const;
  private closed = false;
  constructor(
    network: 'testnet',
    private readonly acquire: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {
    if (network !== 'testnet' || typeof acquire !== 'function')
      deny('live_risk_provider_invalid_input');
  }
  async observe(
    accountAddress: string,
    suppliedMarket: LiveMarketIdentity,
    suppliedOptions: LiveRiskProviderOptions,
  ): Promise<LiveRiskProviderProof> {
    try {
      // Caller references are captured synchronously, before all budget/IO waits.
      const market = structuredClone(suppliedMarket),
        options = settingsSchema.parse(structuredClone(suppliedOptions));
      const user = address(accountAddress),
        timeout = options.timeoutMs ?? 5000;
      // Official userFees has no dex parameter. HIP-3 deployer/growth/AQA fee
      // scope needs separate proven settings; do not silently use base tier.
      // Refused before any weight is taken.
      if (typeof market?.dex === 'string' && market.dex !== '') deny('live_risk_provider_fee_scope_unproven');
      // All thirteen reads (304) are taken from the budget at once, before this
      // proof's clock starts, instead of each waiting inside the window
      // (bounded on its own, by the same timeout).
      await boundedLiveRead(() => this.acquire(RISK_PROVIDER_WEIGHT), timeout);
      const started = this.now();
      assertMarketIdentity(market);
      if (market.network !== this.network)
        deny('live_risk_provider_source_mismatch');
      const fresh = (at: number) => {
        const now = this.now();
        if (this.closed) deny('live_risk_provider_unavailable');
        if (
          !Number.isSafeInteger(now) ||
          now < 0 ||
          !Number.isSafeInteger(at) ||
          at < 0 ||
          at > now ||
          now - at > 5000 ||
          now - started > timeout
        )
          deny('live_risk_provider_stale');
      };
      fresh(started);
      fresh(market.observedAt);
      const earliestObservedAt = Math.min(started, market.observedAt);
      const sources: { body: Record<string, unknown>; value: unknown }[] = [];
      const read = async (
        type: string,
        weight: number,
        extra: Record<string, unknown> = {},
      ) => {
        const body = { type, ...extra },
          remaining = () => {
            fresh(started);
            fresh(earliestObservedAt);
            return Math.max(1, timeout - (this.now() - started));
          };
        void weight; // reserved with the rest, before the clock
        // Recheck before initiating work; an expired window must not send.
        const response = await boundedLiveRead(() => 
          this.fetcher('https://api.hyperliquid-testnet.xyz/info', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            redirect: 'error',
            signal: AbortSignal.timeout(remaining()),
          }),
          remaining(),
        );
        if (!response.ok) deny('live_risk_provider_unavailable');
        const value = await boundedLiveRead(() => 
          readInfoJson(response, 'risk provider', 2 * 1024 * 1024),
          remaining(),
        );
        fresh(started);
        fresh(earliestObservedAt);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (
            (row.user !== undefined &&
              (typeof row.user !== 'string' || address(row.user) !== user)) ||
            (row.network !== undefined && row.network !== this.network) ||
            (row.dex !== undefined && row.dex !== market.dex)
          )
            deny('live_risk_provider_source_mismatch');
        }
        sources.push({ body, value });
        return value;
      };
      const modes = () =>
        Promise.all([
          read('userRole', 60, { user }),
          read('userAbstraction', 20, { user }),
          read('userDexAbstraction', 20, { user }),
          read('spotClearinghouseState', 2, { user }),
        ]);
      const [initial, rawQuote, rawActive, rawFees, rawDexes, rawTokens] =
        await Promise.all([
          modes(),
          read('metaAndAssetCtxs', 20, { dex: market.dex }),
          read('activeAssetData', 20, { user, coin: market.coin }),
          read('userFees', 20, { user }),
          read('perpDexs', 20),
          read('spotMeta', 20),
        ]);
      mode(initial);
      const list = dexSchema.parse(rawDexes);
      if (list[0] !== null) deny('live_risk_provider_invalid_evidence');
      unique(list.flatMap((v) => (v ? [v.name] : [])));
      const [meta, contexts] = z
        .tuple([metaSchema, contextsSchema])
        .parse(rawQuote);
      unique(meta.universe.map((v) => v.name));
      if (meta.universe.length !== contexts.length)
        deny('live_risk_provider_invalid_evidence');
      const row = meta.universe[market.universeIndex],
        rawContext = contexts[market.universeIndex];
      if (
        !row ||
        !rawContext ||
        row.name !== market.coin ||
        row.szDecimals !== market.sizeDecimals ||
        row.maxLeverage !== market.maxLeverage ||
        row.isDelisted
      )
        deny('live_risk_provider_market_mismatch');
      const context = targetContextSchema.parse(rawContext);
      const tokens = tokensSchema.parse(rawTokens).tokens;
      unique(tokens.map((v) => v.index));
      const usdc = tokens.filter((v) => v.name === 'USDC' && v.isCanonical);
      if (usdc.length !== 1 || meta.collateralToken !== usdc[0]!.index)
        deny('live_risk_provider_fee_scope_unproven');
      const active = activeSchema.parse(rawActive),
        fees = feeSchema.parse(rawFees);
      if (address(active.user) !== user || active.coin !== market.coin)
        deny('live_risk_provider_source_mismatch');
      if (active.leverage.value > row.maxLeverage)
        deny('live_risk_provider_invalid_evidence');
      // Official fee formula: positive maker and taker base fractional rates
      // receive active referral discount; negative rebates do not. Main perps
      // have deployer scale0/growth false and no HIP-3 AQAv1 collateral benefit.
      const discount = Dec.ONE.sub(fees.activeReferralDiscount),
        maker = Dec.from(fees.userAddRate);
      const makerFeeBps = (maker.gt(0) ? maker.mul(discount) : maker)
        .mul(10000)
        .toString();
      const takerFeeBps = Dec.from(fees.userCrossRate)
        .mul(discount)
        .mul(10000)
        .toString();
      mode(await modes());
      fresh(started);
      fresh(earliestObservedAt);
      const completedAt = this.now();
      // Ordering follows request identity, not nondeterministic HTTP completion.
      sources.sort((a, b) =>
        JSON.stringify(a.body).localeCompare(JSON.stringify(b.body)),
      );
      const sourceDigest = createHash('sha256')
        .update(
          JSON.stringify({
            network: this.network,
            user,
            market,
            earliestObservedAt,
            completedAt,
            sources,
          }),
        )
        .digest('hex');
      return frozen({
        network: this.network,
        accountAddress: user,
        coin: market.coin,
        dex: market.dex,
        asset: market.asset,
        market,
        earliestObservedAt,
        completedAt,
        sourceDigest,
        accountModeProof: {
          network: this.network,
          accountAddress: user,
          role: 'user',
          accountAbstraction: 'disabled',
          dexAbstraction: false,
          portfolioMargin: false,
          observedAt: earliestObservedAt,
          completedAt,
          sourceDigest,
        },
        quote: {
          market,
          midPrice: context.midPx,
          markPrice: context.markPx,
          observedAt: earliestObservedAt,
          sourceDigest,
        },
        leverageProofs: [
          {
            network: this.network,
            accountAddress: user,
            coin: market.coin,
            dex: market.dex,
            asset: market.asset,
            value: active.leverage.value,
            type: active.leverage.type,
            maxLeverage: row.maxLeverage,
            observedAt: earliestObservedAt,
            sourceDigest,
          },
        ],
        fees: {
          network: this.network,
          accountAddress: user,
          dex: market.dex,
          observedAt: earliestObservedAt,
          sourceDigest,
          makerFeeBps,
          takerFeeBps,
          extraRiskBufferBps: options.extraRiskBufferBps,
          restingOrderBuilderFeeCapTenthsBps:
            options.restingOrderBuilderFeeCapTenthsBps,
          scope: 'validator_perp',
          calculation: 'documented_fee_formula',
        },
      });
    } catch (error) {
      if (
        error instanceof LiveBoundaryError &&
        error.code.startsWith('live_risk_provider_')
      )
        throw error;
      if (error instanceof z.ZodError)
        deny('live_risk_provider_invalid_evidence');
      return deny('live_risk_provider_unavailable');
    }
  }
  close(): void {
    this.closed = true;
  }
}
