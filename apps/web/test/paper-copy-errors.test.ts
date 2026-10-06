import { expect, it } from 'vitest';
import { paperCopyErrorText } from '@/components/copy/copy-portfolio';
import { ApiError } from '@/lib/api';

/** Web audit L7: a failed pause/resume says so (not the edit dialog's line),
 * a failed stop says why when it can. */
const t = (key: string) => key;
it("names paper copy command failures", () => {
  expect(paperCopyErrorText(t as never, new ApiError(500, 'x'), 'portfolio.copy.actions.failed')).toBe('portfolio.copy.actions.failed');
  expect(paperCopyErrorText(t as never, new ApiError(409, 'x', { code: 'copy_paused' }), 'portfolio.copy.stop.failed')).toBe('trader.copy.errors.paused');
  expect(paperCopyErrorText(t as never, new ApiError(503, 'x', { code: 'busy' }), 'portfolio.copy.stop.failed')).toBe('common.errors.busy');
  expect(paperCopyErrorText(t as never, new ApiError(429, 'x'), 'portfolio.copy.actions.failed')).toBe('common.errors.rateLimited');
});
