import { isDeepStrictEqual } from 'node:util';
import { isHyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { Dec } from '../../common/decimal/dec.js';
import type { LiveAccountSnapshot } from './live-account-observer.js';
import type { LiveRiskReservation } from './live-account-risk.js';
import { buildOrderAction, executionKey, intentFingerprint } from './live-order.js';
import { LIVE_PERP_COIN } from './live-market-resolver.js';
import { ceilDecimalProduct } from './live-risk-rounding.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';

export interface LiveExternalExposureInput {
  readonly now: number;
  readonly accountId: string;
  readonly accountAddress: string;
  readonly coin: string;
  readonly riskPrice: string;
  readonly snapshot: LiveAccountSnapshot;
  readonly reservations: readonly LiveRiskReservation[];
}
function check(value: unknown, code = 'live_risk_liability_conflict'): asserts value {
  if (!value) throw new LiveBoundaryError(code);
}
function money(value: unknown, signed = false): Dec {
  check(typeof value === 'string' && value.length <= 80 && /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value));
  const result = Dec.from(value); check(signed || result.gte(0)); return result;
}
function unique(values: readonly (string | number)[]) { check(new Set(values).size === values.length); }

/** Pure conservative global-exposure arithmetic. Caller supplies validated
 * original-session liabilities and concrete all-venue observations. This
 * result grants no source authority, funded collateral or financial permit. */
export function calculateLiveExternalExposure(raw: LiveExternalExposureInput): Readonly<{ exposureUsd: string; coinExposureUsd: string }> {
  const input = structuredClone(raw), { snapshot, reservations, coin, now } = input;
  check(Number.isSafeInteger(now) && now > 0 && typeof input.accountId === 'string' && input.accountId.length > 0 &&
    isHyperliquidNetwork(snapshot.network) && address(snapshot.accountAddress) === address(input.accountAddress), 'live_risk_identity');
  check(typeof coin === 'string' && LIVE_PERP_COIN.test(coin) && coin.length <= 80);
  const riskPrice = money(input.riskPrice); check(riskPrice.isPositive);
  check(snapshot.positions.length <= 10000 && snapshot.restingOrders.length <= 5000 && reservations.length <= 5001);
  unique(snapshot.positions.map(p => p.coin)); unique(snapshot.positions.map(p => p.asset));
  unique(snapshot.restingOrders.map(o => o.oid)); unique(snapshot.restingOrders.flatMap(o => o.cloid === null ? [] : [o.cloid]));
  unique(reservations.map(r => r.key));
  const byId = new Map(snapshot.restingOrders.map(o => [o.oid, o]));
  const byCloid = new Map(snapshot.restingOrders.filter(o => o.cloid !== null).map(o => [o.cloid!, o]));
  let exposure = Dec.ZERO, target = Dec.ZERO;
  const add = (value: Dec, symbol: string) => { exposure = exposure.add(value); if (symbol === coin) target = target.add(value); };
  for (const p of snapshot.positions) {
    const size = money(p.size, true), value = money(p.positionValue); check(!size.isZero);
    add(p.coin === coin ? Dec.max(value, ceilDecimalProduct([size.abs(), riskPrice])) : value, p.coin);
  }
  for (const o of snapshot.restingOrders) {
    check(typeof o.oid === 'string' && /^[1-9]\d*$/.test(o.oid) && (o.cloid === null || /^0x[0-9a-f]{32}$/.test(o.cloid)) &&
      (o.side === 'B' || o.side === 'A') && typeof o.reduceOnly === 'boolean');
    const remaining = money(o.remainingSize), original = money(o.originalSize), px = money(o.limitPrice), observed = money(o.notionalUsd);
    check(remaining.isPositive && px.isPositive && original.gte(remaining));
    if (!o.reduceOnly) add(Dec.max(observed, ceilDecimalProduct([remaining, o.coin === coin ? Dec.max(px, riskPrice) : px])), o.coin);
  }
  for (const row of reservations) {
    const r = row.intent, market = r.market;
    check(market && row.accountId === input.accountId && r.network === snapshot.network && address(r.accountAddress) === address(input.accountAddress), 'live_risk_identity');
    const canonical = buildOrderAction(r);
    check(row.key === executionKey(r) && row.fingerprint === intentFingerprint(r, canonical) && isDeepStrictEqual(row.action, canonical));
    check(row.state === 'held' && row.exchangeOrderId === null && row.expiresAt > now || row.state === 'resting' && typeof row.exchangeOrderId === 'string' && /^[1-9]\d*$/.test(row.exchangeOrderId), 'live_risk_liability_unknown');
    const matches = [...new Set([byCloid.get(r.cloid), row.exchangeOrderId === null ? undefined : byId.get(row.exchangeOrderId)])].filter(o => o !== undefined);
    check(matches.length <= 1);
    if (matches.length) {
      const o = matches[0]!;
      check(o.coin === market.coin && o.dex === market.dex && o.asset === r.asset && o.side === r.side && o.reduceOnly === r.reduceOnly &&
        money(o.originalSize).eq(r.size) && money(o.limitPrice).eq(r.limitPrice) && (o.cloid === null || o.cloid === r.cloid) &&
        (row.exchangeOrderId === null || o.oid === row.exchangeOrderId));
      check(row.state === 'resting', 'live_risk_liability_unknown');
      continue;
    }
    check(row.state === 'held', 'live_risk_liability_unknown');
    if (!r.reduceOnly) add(Dec.max(money(row.notionalUsd), ceilDecimalProduct([money(r.size), market.coin === coin ? Dec.max(money(r.limitPrice), riskPrice) : money(r.limitPrice)])), market.coin);
  }
  return Object.freeze({ exposureUsd: exposure.toString(), coinExposureUsd: target.toString() });
}
