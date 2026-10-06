import type { HlUserFill } from '../../hyperliquid/types.js';
import { isOutOfScopeSpotFill } from '../../watcher/action-classifier.js';
import type { LiveSourceReadResult } from '../copy-live-source.client.js';
import { liveSourceDigest, parseLiveSourceFill, type LiveSourceFillEvidence } from '../live/copy-live-source-evidence.js';
import { address, LiveBoundaryError } from '../live/wallet-authorization.js';

/** Provider reads of the fast source, both in the mainnet live lane. Each
 * acquires its base weight plus the worst-case list surcharge and gives back
 * what the answer didn't use (`HyperliquidInfoClient.postList`). */
export interface FastSourceReader {
  /** `userFillsByTime` from `from` to now, and when the request left
   * (after any budget wait: the read certifies nothing before it). */
  fills(leader: string, from: number): Promise<{ fills: HlUserFill[]; sentAt: number }>;
  /** `userTwapSliceFillsByTime` from `from` to now, each slice as a fill
   * tagged with its TWAP id (`twapSliceToFill`, as the watcher stores it). */
  twapSlices(leader: string, from: number): Promise<HlUserFill[]>;
}

/** A window with this many rows is saturated (the source contract): the
 * read is cut short of the row that would reach it. */
export const FAST_SOURCE_WINDOW_ROWS = 500;
/** Hyperliquid's per-call row cap: a full page may have more after it. */
const PAGE_ROWS = 2000;
/** A trade the feed reported that REST still hasn't returned this long
 * after it happened no longer holds coverage back (the after-sweep audit
 * reports a fill the stream then missed). */
export const WITNESS_EXPIRY_MS = 60_000;
/** Follow-up reads of one leader start at least this far apart, doubling
 * (up to 8 s) while a witnessed trade stays missing. */
const FOLLOW_UP_MIN_MS = 1000, FOLLOW_UP_MAX_MS = 8000;
const ZERO_HASH = /^0x0{64}$/;
/** As `fills.raw` holds it: a JSON round trip, like the jsonb column (no
 * undefined members, plain objects). */
const stored = (fill: HlUserFill): HlUserFill => JSON.parse(JSON.stringify(fill)) as HlUserFill;
const untaggedZeroHash = (fill: HlUserFill) => (fill.twapId === undefined || fill.twapId === null) && typeof fill.hash === 'string' && ZERO_HASH.test(fill.hash);
/** Weight Hyperliquid counts for one list answer: base 20, plus 1 per 20 items. */
export const listWeight = (items: number) => 20 + Math.ceil(items / 20);

export interface FastSourceStats { reads: number; twapReads: number; weight: number; rows: number }
interface LeaderState {
  /** Trades the feed reported, by tid, until REST returns them. */
  witnessed: Map<string, number>;
  /** Fills REST returned past the last certified `to`. */
  beyond: number | null;
  lastReadAt: number;
  /** Consecutive reads after which a witnessed trade was still missing. */
  misses: number;
}

/**
 * The realtime mainnet copy signal. The trade feed only says *when* to read;
 * the fills come from one `userFillsByTime` read in the live lane, from the
 * stream's `coverage_through + 1` to now.
 *
 * A read certifies its span only up to `min(readStart − G, the earliest
 * trade the feed reported that REST has not returned yet − 1)`: the fill
 * index trails the exchange, so fills younger than G may still be missing,
 * and a reported trade proves a fill exists. Fills past that bound are left
 * for the next read.
 *
 * Rows are normalised exactly like the watched source (`fills.raw`): a
 * ordinary fill as REST returned it, a TWAP slice as `twapSliceToFill`, a
 * zero-hash fill without a TWAP id left out, and spot fills skipped. The same
 * tid read by both paths is then the same evidence, never a conflict. The
 * TWAP endpoint is read only when a zero-hash fill or a missing reported
 * trade calls for it.
 */
export class FastMainnetSource {
  private readonly leaders = new Map<string, LeaderState>();
  private readonly counters = new Map<string, FastSourceStats>();
  /** The last read's clock per leader (asked, left, answered): timing logs. */
  readonly lastTiming = new Map<string, { asked: number; sentAt: number; answeredAt: number }>();
  constructor(private readonly reader: FastSourceReader, readonly graceMs: number, private readonly now: () => number = Date.now,
    private readonly log?: (message: string) => void) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new LiveBoundaryError('live_source_configuration_invalid');
  }

  private state(leader: string): LeaderState {
    let state = this.leaders.get(leader);
    if (!state) { state = { witnessed: new Map(), beyond: null, lastReadAt: 0, misses: 0 }; this.leaders.set(leader, state); }
    return state;
  }

  /** A trade the feed reported for this leader (exchange time, tid). */
  witness(leader: string, tid: number | string, time: number): void {
    if (!Number.isSafeInteger(time) || time <= 0) return;
    const witnessed = this.state(address(leader)).witnessed, id = String(tid);
    if (!witnessed.has(id)) witnessed.set(id, time);
  }

  stats(leader: string): FastSourceStats {
    return { ...(this.counters.get(address(leader)) ?? { reads: 0, twapReads: 0, weight: 0, rows: 0 }) };
  }

  /** When another read of this leader would certify something new, or null. */
  followUp(leader: string): number | null {
    const state = this.leaders.get(address(leader));
    if (!state) return null;
    const witnessed = [...state.witnessed.values()], earliest = Math.min(...witnessed, state.beyond ?? Infinity);
    if (!Number.isFinite(earliest)) return null;
    const gap = Math.min(FOLLOW_UP_MAX_MS, FOLLOW_UP_MIN_MS * 2 ** state.misses);
    return Math.max(earliest + this.graceMs + 100, state.lastReadAt + gap);
  }

  /** Reads from `from` to now; null when nothing can be certified yet. */
  async read(leader: string, from: number): Promise<LiveSourceReadResult | null> {
    const leaderAddress = address(leader), asked = this.now(), state = this.state(leaderAddress);
    if (![from, asked].every(Number.isSafeInteger) || from < 0 || from > asked) throw new LiveBoundaryError('live_source_request_invalid');
    state.lastReadAt = asked;
    const counter = this.counters.get(leaderAddress) ?? { reads: 0, twapReads: 0, weight: 0, rows: 0 };
    this.counters.set(leaderAddress, counter);
    // The observation starts when the request left: a wait for the mainnet
    // budget before it neither ages the evidence nor certifies anything.
    const answer = await this.reader.fills(leaderAddress, from), observedAt = answer.sentAt;
    if (!Number.isSafeInteger(observedAt) || observedAt < asked || observedAt > this.now()) throw new LiveBoundaryError('live_source_request_invalid');
    this.lastTiming.set(leaderAddress, { asked, sentAt: observedAt, answeredAt: this.now() });
    const regular = answer.fills.map(stored);
    counter.reads++; counter.weight += listWeight(regular.length); counter.rows += regular.length;
    const byTid = new Map<string, HlUserFill>();
    for (const row of regular) byTid.set(String(row.tid), row);
    // A trade reported more than G ago that REST did not return may be a
    // TWAP slice, which only the TWAP endpoint returns with its id.
    const missingOld = [...state.witnessed].some(([tid, time]) => time >= from && !byTid.has(tid) && observedAt - time > this.graceMs);
    let requests = 1;
    if (regular.some(untaggedZeroHash) || missingOld) {
      const slices = (await this.reader.twapSlices(leaderAddress, from)).map(stored);
      requests = 2; counter.reads++; counter.twapReads++; counter.weight += listWeight(slices.length); counter.rows += slices.length;
      for (const slice of slices) byTid.set(String(slice.tid), slice);
    }
    for (const tid of byTid.keys()) state.witnessed.delete(tid);
    for (const [tid, time] of state.witnessed) {
      if (time < from) state.witnessed.delete(tid); // already certified before this read
      else if (observedAt - time > WITNESS_EXPIRY_MS) {
        state.witnessed.delete(tid);
        this.log?.(`fast source: trade ${tid} of ${leaderAddress} at ${new Date(time).toISOString()} not returned by REST after ${WITNESS_EXPIRY_MS / 1000} s; no longer waited for`);
      }
    }
    const rows = [...byTid.values()].filter(row => Number.isSafeInteger(row.time) && row.time >= from)
      .sort((a, b) => a.time - b.time || (BigInt(a.tid) < BigInt(b.tid) ? -1 : 1));
    let to = Math.min(observedAt - this.graceMs, Math.min(...state.witnessed.values()) - 1);
    // A full page may stop mid-millisecond; a window must stay unsaturated.
    if (regular.length >= PAGE_ROWS) to = Math.min(to, regular[regular.length - 1]!.time - 1);
    const inWindow = () => rows.filter(row => row.time <= to);
    if (inWindow().length >= FAST_SOURCE_WINDOW_ROWS) to = Math.min(to, inWindow()[FAST_SOURCE_WINDOW_ROWS - 1]!.time - 1);
    const kept = inWindow(), past = rows.filter(row => row.time > to && !isOutOfScopeSpotFill(row) && !untaggedZeroHash(row));
    state.beyond = past.length ? past[0]!.time : null;
    state.misses = [...state.witnessed.values()].some(time => observedAt - time > this.graceMs) ? state.misses + 1 : 0;
    if (to < from) return null;
    const receivedAt = this.now(), parsed = new Map<string, LiveSourceFillEvidence>();
    for (const row of kept) {
      if (isOutOfScopeSpotFill(row) || untaggedZeroHash(row)) continue;
      const fill = parseLiveSourceFill(row, { network: 'mainnet', leaderAddress, from, to, receivedAt, kind: 'fills' });
      parsed.set(fill.id, fill);
    }
    const completedAt = this.now(), fresh = completedAt - observedAt <= 5000;
    const observations = [{ kind: 'fills' as const, from, to, depth: 0, observedAt, completedAt, count: kept.length,
      responseDigest: liveSourceDigest(kept), saturated: false }];
    const result = { network: 'mainnet' as const, leaderAddress, from, to, observedAt, completedAt, fresh, complete: fresh,
      historicalCompleteness: 'unproven' as const, requestsUsed: requests, kinds: ['fills' as const],
      fills: [...parsed.values()].sort((a, b) => a.providerTime - b.providerTime || (BigInt(a.tid) < BigInt(b.tid) ? -1 : 1)), observations, unresolved: [] };
    return { ...result, sourceDigest: liveSourceDigest(result) };
  }
}
