import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpModule } from '../src/common/http/http.module.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { planHyperliquidQuota } from '../src/hyperliquid/hyperliquid-global-quota.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { PageBusyError } from '../src/hyperliquid/request-budgeter.service.js';
import { TradersController } from '../src/traders/traders.controller.js';
import { TradersService } from '../src/traders/traders.service.js';
import { TradeAnalyticsController } from '../src/traders/trade-analytics.controller.js';
import { TradeAnalyticsService } from '../src/traders/trade-analytics.service.js';

// Real quota planner, controllers, exception filter and HTTP serialization;
// only the external service boundary is replaced (no DB or provider access).
describe('shared REST capacity Retry-After on trader routes', () => {
  let app: INestApplication;
  let failure: unknown;
  const address = `0x${'12'.repeat(20)}`;
  const read = async () => { throw failure; };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [HttpModule],
      controllers: [TradersController, TradeAnalyticsController],
      providers: [
        { provide: TradersService, useValue: { transfers: read } },
        { provide: TradeAnalyticsService, useValue: { analytics: read, trades: read } },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => { await app?.close(); });

  it.each(['transfers', 'analytics', 'trades'])('preserves cumulative expiry delay for %s in header and safe envelope', async suffix => {
    const now = 1790000000000;
    try {
      planHyperliquidQuota({ now, leases: [], state: {
        egressKey: 'private-egress', revision: 1, updatedAt: now,
        events: [
          { id: 'private-first', kind: 'rest', units: 50, reservedAt: now, expiresAt: now + 1000 },
          { id: 'private-second', kind: 'rest', units: 70, reservedAt: now, expiresAt: now + 12345 },
          { id: 'private-last', kind: 'rest', units: 1080, reservedAt: now, expiresAt: now + 65000 },
        ],
      }, request: { kind: 'rest', id: 'private-request', weight: 120, sendUntil: now + 5000 } });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(LiveBoundaryError);
    const response = await request(app.getHttpServer()).get(`/traders/${address}/${suffix}`).expect(503);
    expect(response.headers['retry-after']).toBe('13');
    expect(response.body.error).toEqual({ code: 'busy', details: { retryAfterSeconds: 13 } });
    expect(JSON.stringify(response.body)).not.toContain('private-');
    expect(JSON.stringify(response.body)).not.toContain('hyperliquid_quota');
  });

  it.each([new PageBusyError(), new LiveBoundaryError('hyperliquid_quota_connections'),
    Object.assign(new LiveBoundaryError('hyperliquid_quota_exhausted'), { retryAfterMs: 999999999 })])(
    'keeps the bounded default for busy errors without trusted REST-expiry evidence (%s)', async error => {
      failure = error;
      const response = await request(app.getHttpServer()).get(`/traders/${address}/transfers`).expect(503);
      expect(response.headers['retry-after']).toBe('5');
      expect(response.body.error.details.retryAfterSeconds).toBe(5);
    },
  );

  it.each([{ ms: 1, seconds: '1' }, { ms: 65_000, seconds: '65' }])(
    'rounds the valid REST window boundary $ms without an early retry', async ({ ms, seconds }) => {
      failure = new HyperliquidRestCapacityError(ms);
      const response = await request(app.getHttpServer()).get(`/traders/${address}/transfers`).expect(503);
      expect(response.headers['retry-after']).toBe(seconds);
      expect(response.body.error.details.retryAfterSeconds).toBe(Number(seconds));
    },
  );

  it.each([0, -1, NaN, Infinity, 65_001, 1.5])('rejects invalid retry hints %s before HTTP serialization', ms => {
    expect(() => new HyperliquidRestCapacityError(ms)).toThrow('hyperliquid_quota_invalid');
  });
});
