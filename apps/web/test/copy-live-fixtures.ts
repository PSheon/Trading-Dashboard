import type { LiveCopyStrategy, LiveCopyMandate } from '@trading-dashboard/shared/contracts';
import { activityAccount } from './copy-follower-activity-fixtures';
export const liveNow = Date.parse('2026-10-04T00:00:00Z');
export const liveAccount = { ...activityAccount, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() };
export const liveSettings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: 'delta' as const };
export const liveOwner = `0x${'11'.repeat(20)}`;
export const liveStrategy: LiveCopyStrategy = { id: liveAccount.strategyId, mode: 'actual', network: 'testnet', sourceNetwork: 'testnet', leaderAddress: `0x${'44'.repeat(20)}`, budgetUsd: '100', status: 'paused', version: 1, settings: liveSettings, pauseNewRisk: true, reduceOnly: false, createdAt: new Date(liveNow).toISOString() };
export const liveMandate: LiveCopyMandate = { id: 'mandate', accountId: liveAccount.id, strategyId: liveStrategy.id, mode: 'actual', network: 'testnet', accountAddress: liveAccount.address!, sourceNetwork: 'testnet', leaderAddress: liveStrategy.leaderAddress, budgetUsd: '100', strategyVersion: 1, state: 'prepared', revision: 1, activationCursor: null, expiresAt: new Date(liveNow + 86400000).toISOString(), createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() };
export const liveOverview = () => ({ mode: 'actual', network: 'testnet', capabilities: { strategyPreparation: true, automaticExecution: false, sourceNetworks: ['testnet'] }, strategies: [liveStrategy], mandates: [liveMandate] });
