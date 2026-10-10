import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveBudget } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { testConfig } from './config-test-utils.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('unused account-mode admission weight', () => {
  it('returns only undispatched weight once, retaining ambiguous dispatch charges', async () => {
    let available = 800;
    const bucket = {
      liveCapacity: 800, refillMs: () => 120000, liveWaitMs: () => 0,
      acquire: async (weight: number) => { available -= weight; },
      refundLive: (weight: number) => { available += weight; },
    } as unknown as RequestBudgeterService;
    const budget = liveBudget(bucket) as ReturnType<typeof liveBudget> & {
      reserve(weight: number): Promise<{ consume(weight: number): void; release(): void }>;
    };
    const permit = await budget.reserve(613);
    expect(available).toBe(187);
    permit.consume(102); // observation handed to transport, even if its response is lost
    permit.consume(42); // first absence REST batch
    permit.release(); permit.release();
    expect(available).toBe(656);
    expect(() => permit.consume(1)).toThrow();
  });
  it('keeps refunds within the existing 400 per minute and 800 burst bucket capacities', async () => {
    vi.stubEnv('HYPERLIQUID_WEIGHT_BUDGET_PER_MIN', '400');
    vi.stubEnv('HYPERLIQUID_WEIGHT_BURST', '800');
    vi.stubEnv('HYPERLIQUID_STARTUP_PACE_SECONDS', '0');
    const bucket = new RequestBudgeterService(testConfig());
    try {
      const reservation = await liveBudget(bucket).reserve!(613);
      reservation.consume(144);
      expect(() => reservation.consume(470)).toThrow('Invalid reservation consumption');
      reservation.release(); reservation.release();
      const state = bucket.introspect();
      expect(state.tokensAvailable).toBeGreaterThanOrEqual(656);
      expect(state.tokensAvailable).toBeLessThanOrEqual(657);
      expect(state.reserveTokens).toBeLessThanOrEqual(state.reserveCapacity);
      expect(state.weightLastMinute).toBe(144);
      expect(state.consumers.live).toBe(144);
      expect(bucket.liveCapacity).toBe(800);
      expect(state.configuredBudgetPerMin).toBe(400);
    } finally { bucket.onModuleDestroy(); }
  });
  it('refunds no admission weight after both preflights and the POST dispatch', async () => {
    let available = 800;
    const budget = liveBudget({ liveCapacity: 800, liveWaitMs: () => 0, refillMs: () => 120000,
      acquire: async (weight: number) => { available -= weight; }, refundLive: (weight: number) => { available += weight; },
    } as unknown as RequestBudgeterService);
    const reservation = await budget.reserve!(613);
    for (const weight of [102, 42, 40, 20, 102, 102, 42, 40, 20, 102, 1]) reservation.consume(weight);
    reservation.release();
    expect(available).toBe(187);
  });
});
