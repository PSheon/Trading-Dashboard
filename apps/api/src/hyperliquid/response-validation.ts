import { z } from "zod";
import type { HlInfoRequestBody } from "./types.js";

// Validate consumed fields, retain unknown fields for raw fill history / forward compatibility.
const decimal = z.string().max(128).regex(/^-?(?:\d+(?:\.\d*)?|\.\d+)$/).refine(v => Number.isFinite(Number(v)));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(256);
const list = <T extends z.ZodTypeAny>(item: T, max = 10000) => z.array(item).max(max);
const summary = z.object({ accountValue: decimal, totalMarginUsed: decimal, totalNtlPos: decimal, totalRawUsd: decimal }).passthrough();
const fill = z.object({
  coin: name, px: decimal, sz: decimal, side: z.enum(["A", "B"]), time: integer, tid: integer,
  startPosition: decimal.optional(), closedPnl: decimal, fee: decimal,
  dir: z.string(), hash: z.string(), oid: integer, crossed: z.boolean(),
  feeToken: name.optional(), builderFee: decimal.optional(), twapId: integer.nullable().optional(),
}).passthrough();
const history = list(z.tuple([integer, decimal]), 100000);
const rewards = z.object({ cumVlm: decimal, unclaimedRewards: decimal, claimedRewards: decimal, builderRewards: decimal }).passthrough();
const referralState = z.object({
  cumVlm: decimal, cumRewardedFeesSinceReferred: decimal, cumFeesRewardedToReferrer: decimal,
  timeJoined: integer, user: name,
}).passthrough();
const referrerState = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("ready"), data: z.object({ code: z.string(), nReferrals: integer.optional(), referralStates: list(referralState) }).passthrough() }).passthrough(),
  z.object({ stage: z.literal("needToTrade"), data: z.object({ required: decimal }).passthrough().optional() }).passthrough(),
  z.object({ stage: z.literal("needToCreateCode"), data: z.unknown().optional() }).passthrough(),
]);
// Documentation shows a single pair; captured live fixtures contain an array of pairs.
const rewardPair = z.tuple([integer, rewards]);
const tokenRewards = z.union([list(rewardPair), rewardPair.transform(pair => [pair])]);
const schemas = {
  meta: z.object({ universe: list(z.object({ name, szDecimals: integer, maxLeverage: z.number().finite().positive() }).passthrough()) }).passthrough(),
  metaAndAssetCtxs: z.tuple([
    z.object({ universe: list(z.object({ name, szDecimals: integer, maxLeverage: z.number().finite().positive() }).passthrough()) }).passthrough(),
    list(z.object({ funding: decimal, markPx: decimal, midPx: decimal.nullable().optional(), oraclePx: decimal, openInterest: decimal, dayNtlVlm: decimal.optional() }).passthrough()),
  ]),
  perpDexs: list(z.object({ name }).passthrough().nullable()),
  clearinghouseState: z.object({
    assetPositions: list(z.object({ position: z.object({
      coin: name, szi: decimal, entryPx: decimal.nullable().optional(),
      leverage: z.object({ type: z.string(), value: z.number().finite().nonnegative() }).passthrough(),
      liquidationPx: decimal.nullable().optional(), marginUsed: decimal, unrealizedPnl: decimal,
      positionValue: decimal.optional(), returnOnEquity: decimal.optional(),
      cumFunding: z.object({ allTime: decimal, sinceOpen: decimal, sinceChange: decimal }).passthrough().optional(),
    }).passthrough() }).passthrough()),
    marginSummary: summary, crossMarginSummary: summary, withdrawable: decimal, time: integer,
  }).passthrough(),
  userFunding: list(z.object({ time: integer, hash: z.string(), delta: z.object({
    type: z.literal("funding"), coin: name, usdc: decimal, szi: decimal, fundingRate: decimal,
    nSamples: integer.nullable().optional(),
  }).passthrough() }).passthrough(), 500),
  userFills: list(fill, 2000),
  userFillsByTime: list(fill, 2000),
  userTwapSliceFills: list(z.object({ fill, twapId: integer }).passthrough(), 2000),
  userTwapSliceFillsByTime: list(z.object({ fill, twapId: integer }).passthrough(), 2000),
  allMids: z.record(name, decimal),
  spotClearinghouseState: z.object({ balances: list(z.object({
    coin: name, token: integer.optional(), total: decimal, hold: decimal, entryNtl: decimal, supplied: decimal.optional(),
  }).passthrough()), portfolioMarginEnabled: z.boolean().optional() }).passthrough(),
  spotMetaAndAssetCtxs: z.tuple([
    z.object({ tokens: list(z.object({ name, index: integer, szDecimals: integer.optional() }).passthrough()),
      universe: list(z.object({ name, index: integer, tokens: z.tuple([integer, integer]) }).passthrough()),
    }).passthrough(),
    list(z.object({ coin: name, markPx: decimal, midPx: decimal.nullable().optional() }).passthrough()),
  ]),
  userAbstraction: z.enum(["unifiedAccount", "portfolioMargin", "disabled", "default", "dexAbstraction"]),
  delegatorSummary: z.object({ delegated: decimal, undelegated: decimal, totalPendingWithdrawal: decimal, nPendingWithdrawals: integer }).passthrough(),
  portfolio: list(z.tuple([name, z.object({ accountValueHistory: history, pnlHistory: history, vlm: decimal }).passthrough()]), 32),
  frontendOpenOrders: list(z.object({
    coin: name, side: z.enum(["A", "B"]), limitPx: decimal, sz: decimal, oid: integer, timestamp: integer,
    triggerCondition: z.string().nullable().optional(), isTrigger: z.boolean().optional(),
    triggerPx: decimal.nullable().optional(), isPositionTpsl: z.boolean().optional(), reduceOnly: z.boolean().optional(),
    orderType: z.string().nullable().optional(), origSz: decimal.nullable().optional(),
  }).passthrough()),
  twapHistory: list(z.object({
    time: integer, twapId: integer,
    state: z.object({ coin: name, side: z.enum(["A", "B"]), sz: decimal, executedSz: decimal, executedNtl: decimal,
      minutes: integer, reduceOnly: z.boolean(), randomize: z.boolean(), timestamp: integer }).passthrough(),
    status: z.object({ status: z.string() }).passthrough(),
  }).passthrough(), 100000),
  userNonFundingLedgerUpdates: list(z.object({
    time: integer, hash: z.string().max(256), delta: z.object({ type: z.string().max(64) }).passthrough(),
  }).passthrough()),
  referral: rewards.extend({ referredBy: z.object({ referrer: name, code: z.string() }).passthrough().nullable(),
    referrerState,
    rewardHistory: list(z.unknown()), tokenToState: tokenRewards,
  }),
  candleSnapshot: list(z.object({ t: integer, T: integer, s: name, i: z.string().max(8), o: decimal, c: decimal, h: decimal, l: decimal, v: decimal, n: integer }).passthrough(), 5000),
} satisfies Record<HlInfoRequestBody["type"], z.ZodTypeAny>;

export function validateInfoResponse(type: HlInfoRequestBody["type"], value: unknown): unknown {
  const parsed = schemas[type].safeParse(value);
  // Never include raw upstream payloads or validation values in operational logs.
  if (!parsed.success) throw new Error(`Invalid Hyperliquid ${type} response`);
  return parsed.data;
}

/** Bound decoded bytes too; Content-Length may be absent or refer to compressed bytes. */
export const MAX_INFO_RESPONSE_BYTES = 16 * 1024 * 1024;
export async function readInfoJson(response: Response, type: string, maxBytes = MAX_INFO_RESPONSE_BYTES): Promise<unknown> {
  const invalid = () => new Error(`Invalid Hyperliquid ${type} response`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw invalid();
  }
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw invalid(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw invalid(); }
}
