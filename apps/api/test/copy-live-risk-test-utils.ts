import { DEFAULT_COPY_RISK_LIMITS } from '@trading-dashboard/shared/contracts';
import type { LiveAccountRiskInput, LiveRiskReservation } from '../src/copy/live/live-account-risk.js';
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from '../src/copy/live/live-order.js';
import { Dec } from '../src/common/decimal/dec.js';

export const now = 1_790_000_000_000;
export const digest = 'a'.repeat(64), account = `0x${'22'.repeat(20)}` as const;
export function reservation(intent: LiveOrderIntent): LiveRiskReservation {
  const action = buildOrderAction(intent);
  const notional = Dec.from(intent.size).mul(intent.limitPrice);
  return { accountId: 'account', key: executionKey(intent), fingerprint: intentFingerprint(intent, action),
    strategyVersion: 2, policyVersion: 3, authorizationVersion: 4, intent, action, state: 'held',
    expiresAt: now + 60_000, notionalUsd: notional.toString(), marginUsd: intent.reduceOnly ? '0' : notional.div(10).toString(),
    feeBufferUsd: notional.mul('0.001').toString(), exchangeOrderId: null };
}
export function fixture(): LiveAccountRiskInput {
  const market = { network: 'testnet' as const, coin: 'BTC', dex: '', asset: 0, universeIndex: 0, perpDexIndex: 0,
    sizeDecimals: 2, maxLeverage: 20, observedAt: now };
  const intent: LiveOrderIntent = { authorizationId: 'grant', userId: 1, strategyId: 9, walletId: 'agent',
    network: 'testnet', accountAddress: account, reduceOnly: false, cloid: `0x${'ab'.repeat(16)}`,
    asset: 0, side: 'B', size: '1', limitPrice: '100', sizeDecimals: 2, timeInForce: 'Gtc', market };
  return { now, identity: { accountId: 'account', userId: 1, strategyId: 9, strategyVersion: 2, policyVersion: 3,
    authorizationVersion: 4, authorizationId: 'grant', walletId: 'agent', network: 'testnet', accountAddress: account, dedicated: true },
    localSource: { checkedAt: now, sourceDigest: digest }, intent, action: buildOrderAction(intent), market,
    accountSource: { accountId: 'account', userId: 1, strategyId: 9, network: 'testnet', accountAddress: account,
      checkedAt: now, sourceDigest: digest, quarantined: false, snapshot: { network: 'testnet', accountAddress: account,
        role: 'user', accountMode: 'standard', accountAbstraction: 'disabled', observedAt: now, completedAt: now,
        sourceDigest: digest, collateralToken: 7, collateralCoin: 'USDC', perpEquity: '100', totalMarginUsed: '0',
        withdrawable: '100', exposureUsd: '0', restingExposureUsd: '0', grossRestingExposureUsd: '0', positions: [], restingOrders: [],
        dexes: [{ dex: '', perpDexIndex: 0, supported: true, collateralToken: 7, collateralCoin: 'USDC', providerTime: now,
          equity: '100', rawUsd: '100', marginUsed: '0', withdrawable: '100', exposureUsd: '0', crossEquity: '100',
          crossMarginUsed: '0', crossExposureUsd: '0', crossMaintenanceMarginUsed: '0' }],
        coverage: { complete: true, balanceComplete: true, orderComplete: true, listedDexes: [''], observedOrderDexes: [''],
          unobservedOrderDexes: [], earliestProviderTime: now } } },
    policy: { version: 3, limits: { ...DEFAULT_COPY_RISK_LIMITS } },
    strategy: { version: 2, allocatedUsd: '100', settings: { direction: 'same', sizingMode: 'ratio', perTradeUsd: null,
      maxTotalExposureUsd: null, maxLeverage: 10, copyStartMode: 'adopt' } },
    controls: { platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false },
      strategy: { pauseNewRisk: false, reduceOnly: false } },
    quote: { market, midPrice: '100', markPrice: '100', observedAt: now, sourceDigest: digest },
    leverageProofs: [{ network: 'testnet', accountAddress: account, coin: 'BTC', dex: '', asset: 0, value: 10, maxLeverage: 20, type: 'cross', observedAt: now, sourceDigest: digest }],
    fees: { network: 'testnet', accountAddress: account, dex: '', observedAt: now, sourceDigest: digest, makerFeeBps: '-1',
      takerFeeBps: '5', extraRiskBufferBps: '5', restingOrderBuilderFeeCapTenthsBps: 0 },
    signal: { kind: 'fill', leaderSide: 'B', price: '100', at: now },
    userExposureProof: { userId: 1, checkedAt: now, sourceDigest: digest, complete: true,
      network: 'testnet', coin: 'BTC', excludedAccountId: 'account', excludedExecutionKey: executionKey(intent),
      otherAccountsExposureUsd: '0', otherAccountsCoinExposureUsd: '0', ordersLastMinuteExcludingOwn: 0 },
    reservations: { accountId: 'account', userId: 1, network: 'testnet', accountAddress: account, checkedAt: now,
      sourceDigest: digest, complete: true, own: reservation(intent), others: [] } };
}
