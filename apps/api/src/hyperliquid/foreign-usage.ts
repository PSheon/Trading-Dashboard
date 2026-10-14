import { Logger } from '@nestjs/common';
import type { ForeignUsage } from '@trading-dashboard/shared/contracts';

import type { HyperliquidMeterSnapshot } from './postgres-hyperliquid-quota.js';
import { HYPERLIQUID_REST_CAP } from './hyperliquid-global-quota.js';

/**
 * `foreign_usage_suspected` (design §8 I-12, I-15): Hyperliquid refused us
 * for its per-IP rate limit (a REST 429, or a WebSocket rate-limit error)
 * while our own shared meter for that egress key held less than
 * FOREIGN_USAGE_SHARE of the window. Our meter counts everything our
 * processes send from that egress, so the rest of the IP's use is someone
 * else's: Railway's egress (the default pool, and the static gateway "may be
 * shared with other customers") carries other tenants' Hyperliquid traffic.
 * It should stay at zero on our own addresses; a non-zero count is the
 * evidence for moving a role to another region.
 */
export const FOREIGN_USAGE_SHARE = 0.8;
/** Hyperliquid's WebSocket message limit a minute (the meter's ws_message cap). */
export const HYPERLIQUID_WS_MESSAGE_CAP = 2000;

/** What our own sends hold of an egress key's REST window (0..1): every
 * lane's charges; the 1-unit demand and standby markers and the setup
 * holds, which nothing sent, are left out. */
export function restWindowUse(snapshot: Pick<HyperliquidMeterSnapshot, 'rest'>): number {
  const rest = snapshot.rest, setup = Object.values(rest.setup).reduce((sum, units) => sum + units, 0);
  return (rest.background + rest.other + rest.live + rest.page + setup) / HYPERLIQUID_REST_CAP;
}
/** What our own messages hold of an egress key's WebSocket message window (0..1). */
export const wsWindowUse = (snapshot: Pick<HyperliquidMeterSnapshot, 'wsMessages'>) => snapshot.wsMessages / HYPERLIQUID_WS_MESSAGE_CAP;

/** Whether a Hyperliquid WebSocket `error` channel's data names its rate limit. */
export function isWsRateLimit(data: unknown): boolean {
  const text = typeof data === 'string' ? data : (() => { try { return JSON.stringify(data) ?? ''; } catch { return ''; } })();
  return /rate.?limit|too many/i.test(text);
}

export class ForeignUsageCounter {
  #rateLimited = 0;
  #count = 0;
  #last: { at: number; key: string; status: string; ourWindowUse: number } | undefined;
  constructor(private readonly logger: Pick<Logger, 'warn'> = new Logger('HyperliquidEgress'), private readonly now: () => number = Date.now) {}

  /**
   * A rate limit Hyperliquid answered on `key` (`status`: `429`, or
   * `ws_rate_limit`). `ourWindowUse`: our meter's share of that window at
   * the time (undefined: the meter could not be read, then nothing is
   * suspected). Counts it, and logs it, when the share is below
   * FOREIGN_USAGE_SHARE. True when counted.
   */
  note(key: string, status: string, ourWindowUse: number | undefined): boolean {
    this.#rateLimited++;
    if (ourWindowUse === undefined || !Number.isFinite(ourWindowUse) || ourWindowUse >= FOREIGN_USAGE_SHARE) return false;
    const use = Math.round(ourWindowUse * 1000) / 1000;
    this.#count++;
    this.#last = { at: this.now(), key, status, ourWindowUse: use };
    this.logger.warn(`foreign_usage_suspected ${JSON.stringify({ key, ourWindowUse: use, status, count: this.#count })}`);
    return true;
  }

  status(): ForeignUsage {
    const last = this.#last;
    return { rateLimited: this.#rateLimited, count: this.#count, lastAt: last ? new Date(last.at).toISOString() : null,
      lastKey: last?.key ?? null, lastStatus: last?.status ?? null, lastOurWindowUse: last?.ourWindowUse ?? null };
  }
}

/** This process's count (every transport in it reports here). */
export const foreignUsage = new ForeignUsageCounter();
