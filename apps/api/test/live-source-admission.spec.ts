import { describe, expect, it } from 'vitest';
import { liveSourceAdmission, requireLiveSourceAdmission, type LiveSourceAdmission } from '../src/copy/live/postgres-live-risk-authority.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';

/** THE decision of whether a leg may proceed against the leader's source stream (liveSourceAdmission), every branch,
 * without a database: the engine's pre-check, the preparation authority and the preparation all ask it (2bc22705 found
 * the rule in three copies, one drifted: CI 2026-10-23, copy-live-network.spec). */
const t = 1_700_000_000_000, cursor = new Date(t), leaderTime = new Date(t + 10_000);
type State = 'ready' | 'gap' | 'unproven' | 'quarantined';
const stream = (state: State, from: number | null = t - 60_000, through: number | null = t + 60_000, digest: string | null = 'd') =>
  ({ state, coverageFrom: from === null ? null : new Date(from), coverageThrough: through === null ? null : new Date(through), coverageDigest: digest });
const admit: LiveSourceAdmission = { verdict: 'admit' }, wait: LiveSourceAdmission = { verdict: 'wait', code: 'live_risk_source_not_ready' },
  refuse: LiveSourceAdmission = { verdict: 'refuse', code: 'live_risk_source_changed' };

const cases: { name: string; stream: ReturnType<typeof stream> | null | undefined; leg: 'open' | 'close' | undefined; leaderTime?: Date; expected: LiveSourceAdmission }[] = [
  { name: 'no stream row (leader never ingested): refused as a change, never a wait', stream: null, leg: 'open', leaderTime, expected: refuse },
  { name: 'no stream row, a close: refused too', stream: undefined, leg: 'close', leaderTime, expected: refuse },
  { name: 'ready, coverage from before the cursor through past the fill: an open goes', stream: stream('ready'), leg: 'open', leaderTime, expected: admit },
  { name: 'ready: a close goes', stream: stream('ready'), leg: 'close', leaderTime, expected: admit },
  { name: 'ready: an unknown leg is an open and goes', stream: stream('ready'), leg: undefined, leaderTime, expected: admit },
  { name: 'ready, coverage from exactly the cursor: goes', stream: stream('ready', t), leg: 'open', leaderTime, expected: admit },
  { name: 'ready without a fill time (the preparation authority): goes', stream: stream('ready'), leg: 'open', expected: admit },
  { name: 'ready with coverage short of the fill: the stream admits (the preparation checks the fill against the coverage itself)', stream: stream('ready', t - 60_000, t + 5000), leg: 'close', leaderTime, expected: admit },
  { name: 'gap: an open waits (D10), no attempt', stream: stream('gap'), leg: 'open', leaderTime, expected: wait },
  { name: 'gap: an unknown leg is an open and waits', stream: stream('gap'), leg: undefined, leaderTime, expected: wait },
  { name: 'gap with kept coverage reaching the fill: a close goes (D10)', stream: stream('gap'), leg: 'close', leaderTime, expected: admit },
  { name: 'gap with coverage through exactly the fill: a close goes', stream: stream('gap', t - 60_000, t + 10_000), leg: 'close', leaderTime, expected: admit },
  { name: 'gap with kept coverage short of the fill (a gap read stored it beyond): a close waits for the stream', stream: stream('gap', t - 60_000, t + 9999), leg: 'close', leaderTime, expected: wait },
  { name: 'gap without a fill time (the preparation authority): a close goes on the kept coverage', stream: stream('gap', t - 60_000, t - 1), leg: 'close', expected: admit },
  { name: 'gap, coverage short of the fill and starting after the cursor: the wait comes first', stream: stream('gap', t + 1, t + 9999), leg: 'close', leaderTime, expected: wait },
  { name: 'unproven (after a restart): every leg waits', stream: stream('unproven'), leg: 'close', leaderTime, expected: wait },
  { name: 'quarantined: every leg waits', stream: stream('quarantined'), leg: 'close', leaderTime, expected: wait },
  { name: 'ready without coverage yet (no from): waits', stream: stream('ready', null), leg: 'open', leaderTime, expected: wait },
  { name: 'ready without coverage yet (no through): waits', stream: stream('ready', t - 60_000, null), leg: 'open', leaderTime, expected: wait },
  { name: 'ready without a coverage digest: waits', stream: stream('ready', t - 60_000, t + 60_000, null), leg: 'open', leaderTime, expected: wait },
  { name: 'ready with coverage starting after the cursor: refused as a change (the hold CI 2026-10-23 saw was for ever)', stream: stream('ready', t + 1), leg: 'open', leaderTime, expected: refuse },
  { name: 'gap with coverage starting after the cursor: a close is refused as a change', stream: stream('gap', t + 1), leg: 'close', leaderTime, expected: refuse },
  { name: 'coverage starting after the cursor without a fill time (the preparation authority): refused', stream: stream('ready', t + 1), leg: 'close', expected: refuse },
];

describe('liveSourceAdmission', () => {
  it.each(cases)('$name', ({ stream: row, leg, leaderTime: at, expected }) => {
    expect(liveSourceAdmission(row, leg, cursor, at)).toEqual(expected);
  });
  it('the verdict codes are the authority\'s: a wait is live_risk_source_not_ready, a refusal live_risk_source_changed', () => {
    expect(liveSourceAdmission(stream('gap'), 'open', cursor, leaderTime)).toEqual({ verdict: 'wait', code: 'live_risk_source_not_ready' });
    expect(liveSourceAdmission(null, 'open', cursor, leaderTime)).toEqual({ verdict: 'refuse', code: 'live_risk_source_changed' });
  });
});

describe('requireLiveSourceAdmission', () => {
  const thrown = (work: () => void) => { try { work(); } catch (error) { return error; } return undefined; };
  it('returns on admit', () => {
    expect(() => requireLiveSourceAdmission(stream('ready'), 'open', cursor, leaderTime)).not.toThrow();
  });
  it('throws the wait code as a LiveBoundaryError, whatever refusal code the caller names', () => {
    const error = thrown(() => requireLiveSourceAdmission(stream('gap'), 'open', cursor, leaderTime, 'live_preparation_source'));
    expect(error).toBeInstanceOf(LiveBoundaryError); expect((error as LiveBoundaryError).code).toBe('live_risk_source_not_ready');
  });
  it('throws live_risk_source_changed on a refusal (the authority)', () => {
    expect((thrown(() => requireLiveSourceAdmission(null, 'open', cursor)) as LiveBoundaryError).code).toBe('live_risk_source_changed');
    expect((thrown(() => requireLiveSourceAdmission(stream('ready', t + 1), 'open', cursor)) as LiveBoundaryError).code).toBe('live_risk_source_changed');
  });
  it('throws the caller\'s own refusal code when it names one (the preparation: live_preparation_source)', () => {
    expect((thrown(() => requireLiveSourceAdmission(undefined, 'close', cursor, leaderTime, 'live_preparation_source')) as LiveBoundaryError).code).toBe('live_preparation_source');
    expect((thrown(() => requireLiveSourceAdmission(stream('gap', t + 1), 'close', cursor, leaderTime, 'live_preparation_source')) as LiveBoundaryError).code).toBe('live_preparation_source');
  });
});
