import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { fillCoverage, fills } from '@trading-dashboard/shared/database';
import { CHAIN_DEFAULT } from '@trading-dashboard/shared/contracts';
import type { DbExecutor } from '../../db/unit-of-work.js';
import type { LiveSourceReadResult } from '../copy-live-source.client.js';
import { liveSourceDigest, parseLiveSourceFill, type LiveSourceFillEvidence } from '../live/copy-live-source-evidence.js';
import { address, LiveBoundaryError } from '../live/wallet-authorization.js';
import { LIVE_EVIDENCE_MAX_AGE_MS } from '../../config/constants/timings.js';

/** Rows per window; a fuller window stops one millisecond before its last row. */
const WATCHED_WINDOW_ROWS = 400;
/** Rows one window's observation may hold (the source evidence contract). */
const MILLISECOND_ROWS = 2000;
const ZERO_HASH = /^0x0{64}$/;

/**
 * Mainnet leader fills for testnet copies, without another Hyperliquid read:
 * the market watcher already confirms every watched leader's fills over REST
 * (`fills`, raw payloads) and records the span it proved complete
 * (`fill_coverage.verified_from … verified_through`). A window is reported
 * complete only inside that proven span, so an unconfirmed fill is never
 * treated as absent; the stream simply waits for the watcher.
 *
 * TWAP slices that carry no TWAP id (zero hash) are left out: without the
 * id they cannot be told apart, so they are not copied.
 */
export class WatchedMainnetSource {
  constructor(private readonly db: DbExecutor, private readonly now = Date.now, private readonly log?: (message: string) => void) {}

  async read(leader: string, from: number, to: number): Promise<LiveSourceReadResult | null> {
    const leaderAddress = address(leader), observedAt = this.now();
    if (![from, to, observedAt].every(Number.isSafeInteger) || from < 0 || from > to || to > observedAt) throw new LiveBoundaryError('live_source_request_invalid');
    const [coverage] = await this.db.select().from(fillCoverage)
      .where(and(eq(fillCoverage.chain, CHAIN_DEFAULT), eq(fillCoverage.address, leaderAddress)));
    if (!coverage?.verifiedFrom || !coverage.verifiedThrough || coverage.verifiedFrom.getTime() > from) return null;
    let through = Math.min(to, coverage.verifiedThrough.getTime());
    if (through < from) return null;
    const span = (until: number, limit: number) => this.db.select({ raw: fills.raw, ts: fills.ts }).from(fills)
      .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, leaderAddress), gte(fills.ts, new Date(from)), lte(fills.ts, new Date(until))))
      .orderBy(asc(fills.ts), asc(fills.tid)).limit(limit);
    let rows = await span(through, WATCHED_WINDOW_ROWS), sealed = false;
    if (rows.length >= WATCHED_WINDOW_ROWS) {
      const at = rows[rows.length - 1]!.ts.getTime();
      if (at > from) {
        through = at - 1;
        rows = rows.filter(row => row.ts.getTime() <= through);
      } else {
        // A full window all in its first millisecond: stopping before it
        // would end every later read before `from` too, forever. That
        // millisecond is read whole instead, as a window of its own.
        through = from;
        rows = await span(from, MILLISECOND_ROWS);
        if (rows.length >= MILLISECOND_ROWS) return this.unreadable(leaderAddress, from, observedAt, rows);
        sealed = rows.length >= 500;
      }
    }
    const receivedAt = this.now(), parsed = new Map<string, LiveSourceFillEvidence>();
    for (const row of rows) {
      const raw = row.raw as Record<string, unknown>;
      if ((raw.twapId === undefined || raw.twapId === null) && typeof raw.hash === 'string' && ZERO_HASH.test(raw.hash)) continue;
      const fill = parseLiveSourceFill(raw, { network: 'mainnet', leaderAddress, from, to: through, receivedAt, kind: 'fills' });
      parsed.set(fill.id, fill);
    }
    const completedAt = this.now();
    const observations = [{ kind: 'fills' as const, from, to: through, depth: 0, observedAt, completedAt, count: rows.length,
      responseDigest: liveSourceDigest(rows.map(row => row.raw)), saturated: false, ...(sealed ? { sealed: true as const } : {}) }];
    const result = { network: 'mainnet' as const, leaderAddress, from, to: through, observedAt, completedAt, fresh: completedAt - observedAt <= LIVE_EVIDENCE_MAX_AGE_MS,
      complete: completedAt - observedAt <= LIVE_EVIDENCE_MAX_AGE_MS, historicalCompleteness: 'unproven' as const, requestsUsed: 1, kinds: ['fills' as const],
      fills: [...parsed.values()].sort((a, b) => a.providerTime - b.providerTime || (BigInt(a.tid) < BigInt(b.tid) ? -1 : 1)), observations, unresolved: [] };
    return { ...result, sourceDigest: liveSourceDigest(result) };
  }

  /** The millisecond at `from` holds more rows than one window may: an
   * incomplete read (it certifies nothing) that puts the stream into gap,
   * so the stall is seen. */
  private unreadable(leaderAddress: string, from: number, observedAt: number, rows: { raw: unknown }[]): LiveSourceReadResult {
    this.log?.(`ALERT watched source: ${leaderAddress} has ${rows.length}+ fills at ${new Date(from).toISOString()}, more than one window holds; ` +
      'that millisecond cannot be certified, stream set to gap (incomplete_coverage)');
    const completedAt = this.now(), fresh = completedAt - observedAt <= LIVE_EVIDENCE_MAX_AGE_MS;
    const observations = [{ kind: 'fills' as const, from, to: from, depth: 0, observedAt, completedAt, count: rows.length,
      responseDigest: liveSourceDigest(rows.map(row => row.raw)), saturated: true }];
    const result = { network: 'mainnet' as const, leaderAddress, from, to: from, observedAt, completedAt, fresh, complete: false,
      historicalCompleteness: 'unproven' as const, requestsUsed: 1, kinds: ['fills' as const], fills: [], observations, unresolved: [] };
    return { ...result, sourceDigest: liveSourceDigest(result) };
  }
}
