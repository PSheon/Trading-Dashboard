import { describe, expect, it, vi } from 'vitest';
import { LEADER_ACTIVITY_WINDOW_MS, MAX_LEADER_ORDERS_PER_DAY, MAX_LEADER_ORDERS_PER_MINUTE, leaderActivityVerdict, leaderCopyActivity, leaderCopyActivitySchema,
  measureLeaderActivity, wireLeaderCopyActivitySchema } from '@trading-dashboard/shared/contracts';
import { LeaderActivityService } from '../src/traders/leader-activity.service.js';
import type { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';

const now = Date.UTC(2026, 9, 12, 12);
const fill = (oid: number | string, secondsAgo: number) => ({ oid, time: now - secondsAgo * 1000, coin: 'BTC' });

describe('measureLeaderActivity', () => {
  it('counts an order once however many partial fills it has', () => {
    expect(measureLeaderActivity([fill(1, 10), fill(1, 9), fill(1, 8), fill(2, 5)], now, false)).toEqual({ orders: 2, peakPerMinute: 2, saturated: false });
  });

  it('counts only orders filled in the last 24 h', () => {
    const old = { oid: 9, time: now - LEADER_ACTIVITY_WINDOW_MS - 1, coin: 'ETH' };
    expect(measureLeaderActivity([old, fill(1, 60)], now, false).orders).toBe(1);
  });

  it('peaks over any sliding 60 s, by each order\'s first fill, in any input order', () => {
    // 3 orders in 59 s, a 4th exactly 60 s after the first (outside its window).
    const fills = [fill('d', 3600 - 60), fill('b', 3600 - 30), fill('a', 3600), fill('c', 3600 - 59), fill('a', 3600 - 90)];
    expect(measureLeaderActivity(fills, now, false).peakPerMinute).toBe(3);
    expect(measureLeaderActivity([], now, false)).toEqual({ orders: 0, peakPerMinute: 0, saturated: false });
  });

  it('marks a full page saturated', () => {
    expect(measureLeaderActivity([fill(1, 1)], now, true).saturated).toBe(true);
  });
});

describe('leaderActivityVerdict', () => {
  it('fits at the limits and refuses past them', () => {
    expect(leaderActivityVerdict({ orders: MAX_LEADER_ORDERS_PER_DAY, peakPerMinute: MAX_LEADER_ORDERS_PER_MINUTE, saturated: false })).toBeNull();
    expect(leaderActivityVerdict({ orders: MAX_LEADER_ORDERS_PER_DAY + 1, peakPerMinute: 1, saturated: false })).toBe('orders_per_day');
    expect(leaderActivityVerdict({ orders: 10, peakPerMinute: MAX_LEADER_ORDERS_PER_MINUTE + 1, saturated: false })).toBe('orders_per_minute');
  });

  it('counts a saturated read as over the daily limit', () => {
    expect(leaderActivityVerdict({ orders: 5, peakPerMinute: 1, saturated: true })).toBe('orders_per_day');
  });

  it('a ~150 fills/min vault is refused', () => {
    const fills = Array.from({ length: 2000 }, (_, i) => fill(i, i * 0.4));
    expect(leaderActivityVerdict(measureLeaderActivity(fills, now, true))).toBe('orders_per_day');
    expect(leaderActivityVerdict(measureLeaderActivity(fills.slice(0, 200), now, false))).toBe('orders_per_minute');
  });
});

describe('leaderCopyActivity', () => {
  it('parses as the domain and wire schema', () => {
    const answer = leaderCopyActivity({ orders: 12, peakPerMinute: 7, saturated: false }, new Date(now));
    expect(leaderCopyActivitySchema.parse(answer)).toEqual({ orders: 12, peakPerMinute: 7, saturated: false, fits: false, reason: 'orders_per_minute',
      limits: { perDay: MAX_LEADER_ORDERS_PER_DAY, perMinute: MAX_LEADER_ORDERS_PER_MINUTE }, measuredAt: new Date(now) });
    expect(wireLeaderCopyActivitySchema.safeParse(JSON.parse(JSON.stringify(answer))).success).toBe(true);
  });
});

describe('LeaderActivityService', () => {
  it('reads one 24 h page per address as page work, caches it, and marks a full page saturated', async () => {
    const userFillsByTime = vi.fn(async () => Array.from({ length: 2000 }, (_, i) => fill(i, i)));
    const service = new LeaderActivityService({ userFillsByTime } as unknown as HyperliquidInfoClient, () => now);
    const address = `0x${'AB'.repeat(20)}`;
    const first = await service.copyActivity(address);
    expect(first).toMatchObject({ fits: false, reason: 'orders_per_day', saturated: true, measuredAt: new Date(now) });
    expect(await service.copyActivity(address.toLowerCase())).toBe(first);
    expect(userFillsByTime).toHaveBeenCalledTimes(1);
    expect(userFillsByTime).toHaveBeenCalledWith(address.toLowerCase(), now - LEADER_ACTIVITY_WINDOW_MS, now, 'background', 2);
  });
});
