import { describe, expect, it } from 'vitest';
import { describeUnexpected } from '../src/copy/live-worker/copy-live-engine.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';

// Stage 2026-10-06: a leg failed as `live_execution_failed` five times with
// nothing in the log; an unexpected error must be described there.
describe('the engine describes a leg failure it has no code for', () => {
  it('names a TypeError with its message and stack', () => {
    const text = describeUnexpected(new TypeError("Cannot read properties of undefined (reading 'px')"));
    expect(text).toMatch(/^TypeError: Cannot read properties of undefined \(reading 'px'\) @ /);
  });
  it('stays quiet for a boundary code or a code-shaped message (those are stored as they are)', () => {
    expect(describeUnexpected(new LiveBoundaryError('live_risk_stale'))).toBeNull();
    expect(describeUnexpected(new Error('hyperliquid_quota_exhausted'))).toBeNull();
  });
});
