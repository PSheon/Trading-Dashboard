import { expect, it } from 'vitest';
import { copyErrorMessages } from '@/i18n/copy-errors';
import { liveSetupMessages } from '@/i18n/live-setup';
import { ApiError } from '@/lib/api';
import { copyErrorText } from '@/lib/copy-error-text';

/** Web audit L7: a failed pause/resume says so (not the edit dialog's line),
 * a failed stop says why when it can. Paper and testnet copies share one
 * error text (copyErrorText); paper passes its codes' words and fallback. */
const texts = { live: liveSetupMessages.en, extra: copyErrorMessages.en };
const paper = (error: unknown, fallback: string) => copyErrorText(texts, error, { fallback, codes: { copy_paused: 'paused', copy_not_open: 'disabled', copy_disabled: 'disabled' } });
it("names paper copy command failures", () => {
  expect(paper(new ApiError(500, 'x'), 'actions failed')).toBe('actions failed');
  expect(paper(new ApiError(409, 'x', { code: 'copy_paused' }), 'stop failed')).toBe('paused');
  expect(paper(new ApiError(409, 'x', { code: 'copy_disabled' }), 'stop failed')).toBe('disabled');
  expect(paper(new ApiError(503, 'x', { code: 'busy' }), 'stop failed')).toBe(texts.extra.busy);
  expect(paper(new ApiError(429, 'x'), 'actions failed')).toBe(texts.extra.rateLimited);
  // Without a fallback, the generic line; a testnet code keeps its own words.
  expect(copyErrorText(texts, new ApiError(500, 'x'))).toBe(texts.live.errors.generic);
  expect(copyErrorText(texts, new ApiError(409, 'x', { code: 'worker_signer_missing' }))).toBe(texts.live.errors.worker_signer_missing);
  expect(copyErrorText(texts, new Error('worker_signer_missing'))).toBe(texts.live.errors.worker_signer_missing);
});
