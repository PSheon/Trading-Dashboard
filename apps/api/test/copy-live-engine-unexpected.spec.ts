import { describe, expect, it } from 'vitest';
import { describeUnexpected, redactSecrets } from '../src/copy/live-worker/copy-live-engine.js';
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
  it('never logs key or signature material an error might echo (security review 2026-10-06)', () => {
    const key = `0x${'ab'.repeat(32)}`, sig = `0x${'cd'.repeat(65)}`, jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
    const text = describeUnexpected(new Error(`signing failed for key ${key} sig ${sig} with ${jwt}; Authorization: Bearer abc.def`))!;
    for (const secret of [key, sig, jwt, 'abc.def']) expect(text).not.toContain(secret);
    // An address (40 hex) stays readable: it is public and needed to debug.
    expect(redactSecrets(`account 0x${'12'.repeat(20)}`)).toBe(`account 0x${'12'.repeat(20)}`);
  });
});
