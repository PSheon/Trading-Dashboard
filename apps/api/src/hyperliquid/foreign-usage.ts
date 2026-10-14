import { Logger } from '@nestjs/common';
import type { ForeignUsage } from '@trading-dashboard/shared/contracts';

import type { HyperliquidMeterSnapshot } from './postgres-hyperliquid-quota.js';

import { ALERT_EVERY_MS } from '../config/constants/alerts.js';
import { FOREIGN_USAGE_SHARE, HYPERLIQUID_REST_CAP, HYPERLIQUID_WS_MESSAGE_CAP } from '../config/constants/hyperliquid.js';


/** What our own sends hold of an egress key's REST window (0..1): every
 * lane's charges; the 1-unit demand and standby markers and the setup
 * holds, which nothing sent, are left out. */
export function restWindowUse(snapshot: Pick<HyperliquidMeterSnapshot, 'rest'>): number {
  const rest = snapshot.rest, setup = Object.values(rest.setup).reduce((sum, units) => sum + units, 0);
  return (rest.background + rest.other + rest.live + rest.page + setup) / HYPERLIQUID_REST_CAP;
}
/** What our own messages hold of an egress key's WebSocket message window (0..1). */
export const wsWindowUse = (snapshot: Pick<HyperliquidMeterSnapshot, 'wsMessages'>) => snapshot.wsMessages / HYPERLIQUID_WS_MESSAGE_CAP;

const wsErrorText = (data: unknown): string => typeof data === 'string' ? data : (() => { try { return JSON.stringify(data) ?? ''; } catch { return ''; } })();

/** Whether a Hyperliquid WebSocket `error` channel's data names its rate
 * limit. The wording is not verified against Hyperliquid yet: every error
 * this does not match is logged as `hl_ws_error_unmatched` (sanitised) so
 * the observe week can calibrate it. */
export function isWsRateLimit(data: unknown): boolean {
  return /rate.?limit|too many/i.test(wsErrorText(data));
}

/** The longest unmatched WS error text logged. */
export const WS_ERROR_TEXT_MAX = 200;
/** Distinct texts remembered for that rate limit (the oldest go first). */
const WS_ERROR_TEXTS_KEPT = 200;

/**
 * A WebSocket error's text, safe to log: anything that looks like an
 * address, a hash or a token (0x-hex, a long hex run, a long run of
 * letters and digits such as base58, base64 or a JWT) is replaced,
 * whitespace is collapsed, and the result is cut to WS_ERROR_TEXT_MAX
 * characters.
 */
export function sanitizeWsErrorText(data: unknown): string {
  const text = wsErrorText(data)
    .replace(/0x[0-9a-f]{6,}/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/[A-Za-z0-9_+/=.-]{20,}/g, (run) => /\d/.test(run) ? '<token>' : run)
    .replace(/\s+/g, ' ').trim();
  return text.length > WS_ERROR_TEXT_MAX ? text.slice(0, WS_ERROR_TEXT_MAX) : text;
}

export class ForeignUsageCounter {
  #rateLimited = 0;
  #count = 0;
  #last: { at: number; key: string; status: string; ourWindowUse: number } | undefined;
  readonly #unmatched = new Map<string, number>();
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

  /**
   * A WebSocket `error` that isWsRateLimit did not match: logged as
   * `hl_ws_error_unmatched {text}` (sanitizeWsErrorText), each distinct text
   * at most once every ALERT_EVERY_MS. True when logged.
   */
  noteUnmatchedWsError(data: unknown): boolean {
    const text = sanitizeWsErrorText(data), now = this.now(), at = this.#unmatched.get(text);
    if (at !== undefined && now - at < ALERT_EVERY_MS) return false;
    this.#unmatched.delete(text);
    this.#unmatched.set(text, now);
    if (this.#unmatched.size > WS_ERROR_TEXTS_KEPT) { const oldest = this.#unmatched.keys().next().value; if (oldest !== undefined) this.#unmatched.delete(oldest); }
    this.logger.warn(`hl_ws_error_unmatched ${JSON.stringify({ text })}`);
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
