import type { copyLiveDispatches } from '@trading-dashboard/shared/database';

/**
 * One structured line per dispatch-row transition of the live copy path
 * (`{"ev":"copy_leg",...}`), beside the prose line operators read. Emitted by
 * CopyLiveEngine through LiveEngineDependencies.event exactly once per row
 * write that moved the row (its CAS succeeded) and changed its state or its
 * reason. Stable shape: the keys below, in this order; the acceptance script
 * (scripts/ops/copy-acceptance.mjs) joins `legId` on copy_live_dispatches.id
 * and `corr` on copy_live_dispatches.source_fill_id / copy_live_source_fills.id.
 * No wallet ids, no account addresses, no execution key (it carries the
 * follower's address): the leader address inside `corr` is the one already logged.
 */
export const LIVE_LEG_EVENT = 'copy_leg';
type Dispatch = typeof copyLiveDispatches.$inferSelect;
export type LiveLegState = Dispatch['state'];
/** A row's state after the write, or `waiting`: still the same state, with a new reason (a hold, a retry, a settlement still pending). */
export type LiveLegTo = LiveLegState | 'waiting';
export interface LiveLegEvent {
  readonly ev: typeof LIVE_LEG_EVENT;
  /** copy_live_dispatches.id: `<mandateId>|<sourceFillId>|<leg>`. */
  readonly legId: string;
  readonly strategyId: number;
  readonly accountId: string;
  /** The leader address (already in the prose lines); null only for a row whose generation the engine has not loaded. */
  readonly leader: string | null;
  readonly coin: string;
  readonly leg: Dispatch['leg'];
  readonly from: LiveLegState;
  readonly to: LiveLegTo;
  /** copy_live_dispatches.reason after the write (a refusal, a wait, or null once sent/settled). */
  readonly reason: string | null;
  /** copy_live_dispatches.attempts after the write. */
  readonly attempt: number;
  /** Elapsed since the leader's fill (leader_time), ms, at the write. */
  readonly ms: number;
  /** Correlation id: the leader fill's id (copy_live_source_fills.id, `<network>:<leader>:<tid>`), shared by every leg and copy of that fill. */
  readonly corr: string;
}
export type LiveLegRow = Pick<Dispatch, 'id' | 'mandateId' | 'strategyId' | 'accountId' | 'coin' | 'leg' | 'state' | 'reason' | 'attempts' | 'sourceFillId' | 'leaderTime'>;
/** What the write set (the row as read is `from`, with its reason and attempts). */
export interface LiveLegWrite { state?: LiveLegState; reason?: string | null; attempts?: number }

/** Whether a write that succeeded is a transition worth an event (its state or reason changed). */
export function legTransitioned(row: Pick<LiveLegRow, 'state' | 'reason'>, write: LiveLegWrite): boolean {
  return (write.state !== undefined && write.state !== row.state) || (write.reason !== undefined && write.reason !== row.reason);
}

export function legEvent(row: LiveLegRow, leader: string | null, write: LiveLegWrite, now: number): LiveLegEvent {
  const to: LiveLegTo = write.state !== undefined && write.state !== row.state ? write.state : 'waiting';
  return {
    ev: LIVE_LEG_EVENT, legId: row.id, strategyId: row.strategyId, accountId: row.accountId, leader, coin: row.coin, leg: row.leg,
    from: row.state, to, reason: write.reason === undefined ? row.reason : write.reason, attempt: write.attempts ?? row.attempts,
    ms: Math.max(0, now - row.leaderTime.getTime()), corr: row.sourceFillId,
  };
}
/** The log line: one JSON object, no nesting. */
export const legEventLine = (event: LiveLegEvent): string => JSON.stringify(event);
