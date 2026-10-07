import { describe, expect, it } from 'vitest';
import { describeUnexpected } from '../src/copy/live-worker/copy-live-engine.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';

// Stage 2026-10-06: a leg failed as `live_execution_failed` five times with
// nothing in the log; an unexpected error must be described there.
describe('the engine describes a leg failure it has no code for', () => {
  it('names the error and where it came from, never its message', () => {
    const text = describeUnexpected(new TypeError("Cannot read properties of undefined (reading 'px')"))!;
    expect(text).toMatch(/^TypeError @ /);
    expect(text).not.toContain('Cannot read');
  });
  it('stays quiet for a boundary code or a code-shaped message (those are stored as they are)', () => {
    expect(describeUnexpected(new LiveBoundaryError('live_risk_stale'))).toBeNull();
    expect(describeUnexpected(new Error('hyperliquid_quota_exhausted'))).toBeNull();
  });
  it('never logs key or signature material an error might echo (security review 2026-10-06)', () => {
    const key = `0x${'ab'.repeat(32)}`, sig = `0x${'cd'.repeat(65)}`, jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
    const text = describeUnexpected(new Error(`signing failed for key ${key} sig ${sig} with ${jwt}; Authorization: Bearer abc.def`))!;
    for (const secret of [key, sig, jwt, 'abc.def', 'signing failed']) expect(text).not.toContain(secret);
  });
  it('reports a wrapped local boundary code without echoing SDK or provider messages', () => {
    const error = new Error('sdk echoed private signature', { cause: new Error('provider echoed private token', {
      cause: new LiveBoundaryError('privy_wallet_identity_stale'),
    }) });
    const text = describeUnexpected(error)!;
    expect(text).toContain('[cause: privy_wallet_identity_stale]');
    expect(text).not.toContain('private signature'); expect(text).not.toContain('private token');
  });
  it('does not evaluate an untrusted cause getter', () => {
    const error = new Error('sdk failed'); let evaluated = false;
    Object.defineProperty(error, 'cause', { get() { evaluated = true; throw new Error('private token'); } });
    expect(describeUnexpected(error)).toMatch(/^Error @ /);
    expect(evaluated).toBe(false);
  });
});
