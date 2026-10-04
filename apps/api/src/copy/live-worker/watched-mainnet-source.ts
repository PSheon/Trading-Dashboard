import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { fillCoverage, fills } from '@trading-dashboard/shared/database';
import { CHAIN_DEFAULT } from '@trading-dashboard/shared/contracts';
import type { DbExecutor } from '../../db/unit-of-work.js';
import type { LiveSourceReadResult } from '../copy-live-source.client.js';
import { liveSourceDigest, parseLiveSourceFill, type LiveSourceFillEvidence } from '../live/copy-live-source-evidence.js';
import { address, LiveBoundaryError } from '../live/wallet-authorization.js';

/** Rows per window; a fuller window stops one millisecond before its last row. */
export const WATCHED_WINDOW_ROWS = 400;
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
  constructor(private readonly db: DbExecutor, private readonly now = Date.now) {}

  async read(leader: string, from: number, to: number): Promise<LiveSourceReadResult | null> {
    const leaderAddress = address(leader), observedAt = this.now();
    if (![from, to, observedAt].every(Number.isSafeInteger) || from < 0 || from > to || to > observedAt) throw new LiveBoundaryError('live_source_request_invalid');
    const [coverage] = await this.db.select().from(fillCoverage)
      .where(and(eq(fillCoverage.chain, CHAIN_DEFAULT), eq(fillCoverage.address, leaderAddress)));
    if (!coverage?.verifiedFrom || !coverage.verifiedThrough || coverage.verifiedFrom.getTime() > from) return null;
    let through = Math.min(to, coverage.verifiedThrough.getTime());
    if (through < from) return null;
    let rows = await this.db.select({ raw: fills.raw, ts: fills.ts }).from(fills)
      .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, leaderAddress), gte(fills.ts, new Date(from)), lte(fills.ts, new Date(through))))
      .orderBy(asc(fills.ts), asc(fills.tid)).limit(WATCHED_WINDOW_ROWS);
    if (rows.length >= WATCHED_WINDOW_ROWS) {
      through = rows[rows.length - 1]!.ts.getTime() - 1;
      if (through < from) return null;
      rows = rows.filter(row => row.ts.getTime() <= through);
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
      responseDigest: liveSourceDigest(rows.map(row => row.raw)), saturated: false }];
    const result = { network: 'mainnet' as const, leaderAddress, from, to: through, observedAt, completedAt, fresh: completedAt - observedAt <= 5000,
      complete: completedAt - observedAt <= 5000, historicalCompleteness: 'unproven' as const, requestsUsed: 1, kinds: ['fills' as const],
      fills: [...parsed.values()].sort((a, b) => a.providerTime - b.providerTime || (BigInt(a.tid) < BigInt(b.tid) ? -1 : 1)), observations, unresolved: [] };
    return { ...result, sourceDigest: liveSourceDigest(result) };
  }
}
