import { describe, expect, it } from 'vitest';
import { legEvent, legEventLine, legTransitioned, LIVE_LEG_EVENT, type LiveLegRow } from '../src/copy/live/live-leg-event.js';

// The shape is a contract with the log parsers (scripts/ops/copy-acceptance.mjs joins legId and corr):
// a key added, removed, renamed or reordered must change this spec on purpose.
const leader = `0x${'44'.repeat(20)}`, T0 = 1_790_000_000_000;
const row: LiveLegRow = { id: `mandate|mainnet:${leader}:7|open`, mandateId: 'mandate', strategyId: 9, accountId: 'account', coin: 'BTC', leg: 'open',
  state: 'pending', reason: null, attempts: 0, sourceFillId: `mainnet:${leader}:7`, leaderTime: new Date(T0) };

describe('live leg event', () => {
  it('has a stable key set and order', () => {
    const event = legEvent(row, leader, { state: 'submitted', reason: null, attempts: 1 }, T0 + 850);
    expect(Object.keys(event)).toEqual(['ev', 'legId', 'strategyId', 'accountId', 'leader', 'coin', 'leg', 'from', 'to', 'reason', 'attempt', 'ms', 'corr']);
    expect(event).toEqual({ ev: LIVE_LEG_EVENT, legId: row.id, strategyId: 9, accountId: 'account', leader, coin: 'BTC', leg: 'open',
      from: 'pending', to: 'submitted', reason: null, attempt: 1, ms: 850, corr: `mainnet:${leader}:7` });
    expect(legEventLine(event)).toBe(`{"ev":"copy_leg","legId":"${row.id}","strategyId":9,"accountId":"account","leader":"${leader}","coin":"BTC","leg":"open",` +
      `"from":"pending","to":"submitted","reason":null,"attempt":1,"ms":850,"corr":"mainnet:${leader}:7"}`);
  });

  it('a write that keeps the state but changes the reason is a wait; one that changes neither is no transition', () => {
    expect(legTransitioned(row, { reason: 'live_risk_source_not_ready' })).toBe(true);
    expect(legEvent(row, leader, { reason: 'live_risk_source_not_ready' }, T0 + 10)).toMatchObject({ from: 'pending', to: 'waiting', reason: 'live_risk_source_not_ready', attempt: 0 });
    expect(legTransitioned(row, { attempts: 1 })).toBe(false);
    expect(legTransitioned({ ...row, reason: 'x' }, { reason: 'x' })).toBe(false);
    expect(legTransitioned({ ...row, state: 'submitted' }, { state: 'settled' })).toBe(true);
  });

  it('carries the row\'s reason and attempts when the write leaves them, and never a negative elapsed time', () => {
    const settled = legEvent({ ...row, state: 'submitted', reason: 'live_settlement_terminal_unproven', attempts: 2 }, null, { state: 'settled', reason: null }, T0 - 5);
    expect(settled).toMatchObject({ from: 'submitted', to: 'settled', reason: null, attempt: 2, ms: 0, leader: null });
    const refused = legEvent(row, leader, { state: 'refused' }, T0);
    expect(refused).toMatchObject({ to: 'refused', reason: null, attempt: 0 });
  });
});
