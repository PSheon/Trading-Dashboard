import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/config';
import { copyErrorMessages } from '@/i18n/copy-errors';
import { liveSetupMessages } from '@/i18n/live-setup';
import { ApiError } from '@/lib/api';
import { copyErrorText, isTransient, retryAfter } from '@/lib/copy-error-text';

/** One helper names every copy failure (web audit M1): the code's own words,
 * then busy / rate limited / signed out, then the generic line; never a raw
 * code or an English status word. */
const texts = (locale: (typeof LOCALES)[number] = 'zh-TW') => ({ live: liveSetupMessages[locale], extra: copyErrorMessages[locale] });

describe('copyErrorText', () => {
  const zh = texts();
  it('names the codes the copy flows meet', () => {
    expect(copyErrorText(zh, new ApiError(409, 'x', { code: 'consent_expired' }))).toBe(zh.live.errors.consent_expired);
    for (const code of ['live_stop_in_progress', 'watch_capacity', 'leverage_above_limit', 'builder_fee_approval_required', 'setup_binding_changed', 'return_requires_flat_stop'] as const) {
      expect(copyErrorText(zh, new ApiError(409, 'English text', { code })), code).toBe(zh.extra.codes[code]);
    }
  });
  it('says busy for Hyperliquid busy, 502/503/504 and the network; rate limited for 429; sign in again for 401', () => {
    for (const error of [new ApiError(503, 'Service Unavailable', { code: 'busy' }), new ApiError(502, 'Bad Gateway', { code: 'bad_gateway' }), new ApiError(504, 'Gateway Timeout', { code: 'deadline_exceeded' }),
      new ApiError(409, 'x', { code: 'hyperliquid_busy' }), new TypeError('Failed to fetch')]) {
      expect(isTransient(error)).toBe(true);
      expect(copyErrorText(zh, error)).toBe(zh.extra.busy);
    }
    expect(copyErrorText(zh, new ApiError(429, 'Too Many Requests'))).toBe(zh.extra.rateLimited);
    expect(copyErrorText(zh, new ApiError(401, 'Unauthorized'))).toBe(zh.extra.signInAgain);
    expect(isTransient(new ApiError(404, 'Not Found'))).toBe(false);
  });
  it("turns the flows' own throws into words: no wallet, a changed session, a wallet not ready, a cancelled signature", () => {
    expect(copyErrorText(zh, new Error('owner_wallet_unavailable'))).toBe(zh.extra.codes.owner_wallet_unavailable);
    expect(copyErrorText(zh, new Error('live_session_changed'))).toBe(zh.extra.codes.live_session_changed);
    expect(copyErrorText(zh, new Error('Wallet is not ready. Reload or sign in again.'))).toBe(zh.live.errors.wallet_not_ready);
    expect(copyErrorText(zh, new Error('User rejected the request'))).toBe(zh.live.errors.signature_rejected);
    expect(copyErrorText(zh, new Error('signing_timeout'))).toBe(zh.extra.signingTimeout);
  });
  it('names the unfinished copy that holds the copy limit', () => {
    const limit = new ApiError(409, 'Copy limit reached', { code: 'strategy_limit', limit: 3, unfinished: [{ strategyId: 9, leaderAddress: `0x${'44'.repeat(20)}`, setupId: 's' }] });
    expect(copyErrorText(zh, limit)).toBe(zh.extra.strategyLimitUnfinished.replace('{limit}', '3').replace('{trader}', '0x4444…4444'));
    expect(copyErrorText(zh, new ApiError(409, 'x', { code: 'strategy_limit', limit: 3 }))).toBe(zh.extra.strategyLimit.replace('{limit}', '3'));
  });
  it('falls back to the generic line, never to the English message or a code', () => {
    const odd = new ApiError(418, "I'm a teapot", { code: 'teapot_brewing' });
    expect(copyErrorText(zh, odd)).toBe(zh.live.errors.generic);
  });
  it('honours Retry-After within bounds', () => {
    expect(retryAfter(new ApiError(503, 'busy', { code: 'busy' }, 30_000), 10_000)).toBe(30_000);
    expect(retryAfter(new ApiError(503, 'busy', { code: 'busy' }, 999_999), 10_000)).toBe(65_000);
    expect(retryAfter(new ApiError(503, 'busy', { code: 'busy' }), 10_000)).toBe(10_000);
  });
  it('every language has every line, with its placeholders', () => {
    for (const locale of LOCALES) {
      const extra = copyErrorMessages[locale];
      const lines = [extra.retrying, extra.stepRetrying, extra.busy, extra.rateLimited, extra.signInAgain, extra.signingTimeout, extra.refusal, ...Object.values(extra.codes)];
      expect(lines.every(line => line.trim().length > 0), locale).toBe(true);
      expect(extra.depositUncredited, locale).toMatch(/\{amount\}[\s\S]*\{address\}|\{address\}[\s\S]*\{amount\}/);
      expect(extra.strategyLimitUnfinished, locale).toContain('{trader}');
      if (locale !== 'en') expect(extra.busy, locale).not.toBe(copyErrorMessages.en.busy);
    }
  });
});
