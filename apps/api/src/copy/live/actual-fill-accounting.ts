import { Dec } from '../../common/decimal/dec.js';
import { address, LiveBoundaryError, type LiveNetwork } from './wallet-authorization.js';
import { LIVE_PERP_COIN } from './live-market-resolver.js';

export interface FollowerReceiptContext {
  network: LiveNetwork;
  accountAddress: string;
  coin?: string;
  oid?: string;
  minTime?: number;
  maxTime?: number;
}
export interface ParsedFollowerFill {
  key: string; network: LiveNetwork; accountAddress: string; tid: string; oid: string;
  coin: string; side: 'B' | 'A'; time: number; size: string; price: string;
  closedPnl: string; totalFee: string; exchangeFee: string; builderFee: string;
  feeToken: 'USDC'; cashDelta: string;
}
export interface ParsedFollowerFunding {
  key: string; network: LiveNetwork; accountAddress: string; hash: string;
  coin: string; time: number; amount: string; cashDelta: string; feeToken: 'USDC';
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LiveBoundaryError('invalid_follower_receipt');
  return value as Record<string, unknown>;
}
function decimal(value: unknown): Dec {
  if (typeof value !== 'string' || value.length > 80 || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value))
    throw new LiveBoundaryError('invalid_receipt_decimal');
  return Dec.from(value);
}
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n) return value;
  throw new LiveBoundaryError('invalid_receipt_id');
}
function identity(row: Record<string, unknown>, ctx: FollowerReceiptContext) {
  const accountAddress = address(ctx.accountAddress);
  if (!['testnet', 'mainnet'].includes(ctx.network) || typeof row.coin !== 'string' ||
      !LIVE_PERP_COIN.test(row.coin) || row.coin.length > 80 ||
      (ctx.coin !== undefined && row.coin !== ctx.coin) || !Number.isSafeInteger(row.time) || (row.time as number) < 0 ||
      (ctx.minTime !== undefined && (!Number.isSafeInteger(ctx.minTime) || (row.time as number) < ctx.minTime)) ||
      (ctx.maxTime !== undefined && (!Number.isSafeInteger(ctx.maxTime) || (row.time as number) > ctx.maxTime)) ||
      (row.user !== undefined && (typeof row.user !== 'string' || address(row.user) !== accountAddress)) ||
      (row.network !== undefined && row.network !== ctx.network)) throw new LiveBoundaryError('follower_receipt_identity_mismatch');
  return { network: ctx.network, accountAddress, coin: row.coin, time: row.time as number };
}

/** Identity can be checked before amount parsing so a corrupted replay of a
 * known receipt still produces durable conflict evidence. It is not validation
 * of the receipt: first-time booking must use the complete parser. */
export function followerReceiptKey(kind: 'fill' | 'funding', value: unknown, expected: Pick<FollowerReceiptContext, 'network' | 'accountAddress'>): string {
  const row = object(value), account = address(expected.accountAddress);
  if (!['testnet', 'mainnet'].includes(expected.network)) throw new LiveBoundaryError('follower_receipt_identity_mismatch');
  if (kind === 'fill') return `${expected.network}:${account}:${id(row.tid)}`;
  const delta = object(row.delta);
  if (typeof row.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.hash) || typeof delta.coin !== 'string' ||
      !/^(?:[A-Za-z0-9]+:)?[A-Za-z0-9]+$/.test(delta.coin) || !Number.isSafeInteger(row.time) || (row.time as number) < 0)
    throw new LiveBoundaryError('follower_receipt_identity_mismatch');
  return `${expected.network}:${account}:${row.hash.toLowerCase()}:${delta.coin}:${row.time}`;
}

/** ctx identifies the fixed-network account read that produced this receipt.
 * Provider fill records do not themselves contain the trading account address. */
export function parseFollowerFill(value: unknown, expected: FollowerReceiptContext): ParsedFollowerFill {
  const row = object(value), ctx = identity(row, expected), tid = id(row.tid), oid = id(row.oid);
  if ((expected.oid !== undefined && oid !== id(expected.oid)) || (row.side !== 'B' && row.side !== 'A') || row.feeToken !== 'USDC')
    throw new LiveBoundaryError('follower_receipt_identity_mismatch');
  const size = decimal(row.sz), price = decimal(row.px), closedPnl = decimal(row.closedPnl), fee = decimal(row.fee);
  // Official API omits builderFee when it is zero; missing total fee is invalid.
  const builderFee = row.builderFee === undefined ? Dec.ZERO : decimal(row.builderFee);
  if (!size.isPositive || !price.isPositive || builderFee.lt(0)) throw new LiveBoundaryError('invalid_follower_fill_amount');
  return { ...ctx, key: `${ctx.network}:${ctx.accountAddress}:${tid}`, tid, oid, side: row.side as 'B' | 'A',
    size: size.toString(), price: price.toString(), closedPnl: closedPnl.toString(), totalFee: fee.toString(),
    exchangeFee: fee.sub(builderFee).toString(), builderFee: builderFee.toString(), feeToken: 'USDC', cashDelta: closedPnl.sub(fee).toString() };
}

/** Funding is actual signed collateral movement, not rate × position × hours. */
export function parseFollowerFunding(value: unknown, expected: FollowerReceiptContext): ParsedFollowerFunding {
  const row = object(value), delta = object(row.delta), ctx = identity({ ...row, coin: delta.coin }, expected);
  if (typeof row.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.hash) ||
      delta.type !== 'funding' ||
      (delta.feeToken !== undefined && delta.feeToken !== 'USDC')) throw new LiveBoundaryError('invalid_follower_funding');
  const amount = decimal(delta.usdc).toString(), hash = row.hash.toLowerCase();
  return { ...ctx, key: `${ctx.network}:${ctx.accountAddress}:${hash}:${ctx.coin}:${ctx.time}`, hash, amount, cashDelta: amount, feeToken: 'USDC' };
}
