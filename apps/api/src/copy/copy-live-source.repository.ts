import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { copyLiveSourceFills, copyLiveSourceStreams } from '@trading-dashboard/shared/database';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
import type { LiveSourceReadResult } from './copy-live-source.client.js';
import { decodeLiveSourceFill, liveSourceDigest } from './live/copy-live-source-evidence.js';
import { address, LiveBoundaryError } from './live/wallet-authorization.js';
export type LiveSourceStream = typeof copyLiveSourceStreams.$inferSelect;
export type SourceApplyResult = { kind: 'recorded' | 'stale' | 'quarantined'; stream: LiveSourceStream };
@Injectable()
export class CopyLiveSourceRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  /** Ingestion owns only the source lock. Never acquire user/account locks after it. */
  async ensure(tx: DbTransaction, leader: string): Promise<LiveSourceStream> {
    const leaderAddress = address(leader), id = `testnet:${leaderAddress}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`live-risk-source:testnet:${leaderAddress}`}, 8))`);
    await tx.insert(copyLiveSourceStreams).values({ id, network: 'testnet', leaderAddress }).onConflictDoNothing();
    const [stream] = await tx.select().from(copyLiveSourceStreams).where(eq(copyLiveSourceStreams.id, id)).for('update');
    if (!stream || stream.network !== 'testnet' || stream.leaderAddress !== leaderAddress) throw new LiveBoundaryError('invalid_live_source_evidence');
    return stream;
  }
  async apply(tx: DbTransaction, expectedRevision: number, input: LiveSourceReadResult, now: number): Promise<SourceApplyResult> {
    const result = structuredClone(input), { sourceDigest, ...body } = result;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || result.network !== 'testnet' || sourceDigest !== liveSourceDigest(body) ||
      ![result.from,result.to,result.observedAt,result.completedAt,now].every(v => Number.isSafeInteger(v) && v >= 0) ||
      result.from > result.to || result.to > result.observedAt || result.observedAt > result.completedAt || result.completedAt > now ||
      result.fills.length > 10000 || result.observations.length > 64 || !Number.isSafeInteger(result.requestsUsed) || result.requestsUsed < result.observations.length || result.requestsUsed > result.observations.length + 1 || result.requestsUsed > 64 ||
      result.historicalCompleteness !== 'unproven' || (result.complete && (!result.fresh || result.unresolved.length !== 0))) throw new LiveBoundaryError('invalid_live_source_evidence');
    const leader = address(result.leaderAddress), decoded = result.fills.map(fill => decodeLiveSourceFill({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) }));
    if (new Set(decoded.map(fill => fill.id)).size !== decoded.length || decoded.some(fill => fill.leaderAddress !== leader || fill.providerTime < result.from || fill.providerTime > result.to || fill.receivedAt < result.observedAt || fill.receivedAt > result.completedAt)) throw new LiveBoundaryError('invalid_live_source_evidence');
    for (const window of result.observations) if (!['fills','twap'].includes(window.kind) || ![window.from,window.to,window.depth,window.observedAt,window.completedAt,window.count].every(Number.isSafeInteger) ||
      window.from < result.from || window.to > result.to || window.from > window.to || window.depth < 0 || window.depth > 48 || window.observedAt < result.observedAt || window.completedAt < window.observedAt || window.completedAt > result.completedAt ||
      window.count < 0 || window.count > 2000 || window.saturated !== (window.count >= 500) || !/^[a-f0-9]{64}$/.test(window.responseDigest)) throw new LiveBoundaryError('invalid_live_source_evidence');
    if (result.complete) for (const kind of ['fills','twap']) {
      const leaves = result.observations.filter(window => window.kind === kind && !window.saturated).sort((a,b) => a.from - b.from);
      let next = result.from;
      for (const leaf of leaves) { if (leaf.from !== next) throw new LiveBoundaryError('invalid_live_source_evidence'); next = leaf.to + 1; }
      if (next !== result.to + 1) throw new LiveBoundaryError('invalid_live_source_evidence');
    }
    const stream = await this.ensure(tx, leader);
    if (stream.state === 'quarantined') return { kind: 'quarantined', stream };
    const stored = decoded.length ? await tx.select().from(copyLiveSourceFills).where(and(eq(copyLiveSourceFills.streamId, stream.id), inArray(copyLiveSourceFills.id, decoded.map(fill => fill.id)))) : [];
    const byId = new Map(stored.map(fill => [fill.id, fill]));
    for (const old of stored) {
      try { decodeLiveSourceFill(old); } catch { return this.change(tx, stream, 'quarantined', 'invalid_fill', now); }
    }
    for (const fill of decoded) if (byId.has(fill.id) && byId.get(fill.id)!.sourceDigest !== fill.sourceDigest) return this.change(tx, stream, 'quarantined', 'duplicate_conflict', now);
    // Contradictory identity evidence must quarantine even a stale cursor writer.
    if (stream.revision !== expectedRevision) return { kind: 'stale', stream };
    for (const fill of decoded) if (!byId.has(fill.id)) await tx.insert(copyLiveSourceFills).values({ ...fill, normalized: { ...fill.normalized }, providerTime: new Date(fill.providerTime), receivedAt: new Date(fill.receivedAt) });
    const fresh = result.fresh && now - result.observedAt <= 5000;
    if (!fresh || !result.complete) return this.change(tx, stream, 'gap', fresh ? 'incomplete_coverage' : 'source_unavailable', now);
    if (stream.coverageThrough && (result.from > stream.coverageThrough.getTime() + 1 || result.to < stream.coverageThrough.getTime())) return this.change(tx, stream, 'gap', 'cursor_regression', now);
    const [next] = await tx.update(copyLiveSourceStreams).set({ state: 'ready', revision: stream.revision + 1,
      coverageFrom: new Date(Math.min(result.from, stream.coverageFrom?.getTime() ?? result.from)), coverageThrough: new Date(result.to),
      coverageDigest: liveSourceDigest({ prior: stream.coverageDigest, result: result.sourceDigest }), lastIssue: null, updatedAt: new Date(now) })
      .where(and(eq(copyLiveSourceStreams.id, stream.id), eq(copyLiveSourceStreams.revision, stream.revision))).returning();
    if (!next) throw new LiveBoundaryError('live_source_cas_lost');
    return { kind: 'recorded', stream: next };
  }
  async fail(tx: DbTransaction, leader: string, expectedRevision: number, issue: NonNullable<LiveSourceStream['lastIssue']>, now: number): Promise<SourceApplyResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !Number.isSafeInteger(now) || now < 0 || !['source_unavailable','incomplete_coverage','duplicate_conflict','invalid_fill','cursor_regression'].includes(issue)) throw new LiveBoundaryError('invalid_live_source_evidence');
    const stream = await this.ensure(tx, leader);
    if (stream.state === 'quarantined') return { kind: 'quarantined', stream };
    if (stream.revision !== expectedRevision) return { kind: 'stale', stream };
    return this.change(tx, stream, ['invalid_fill','duplicate_conflict'].includes(issue) ? 'quarantined' : 'gap', issue, now);
  }
  private async change(tx: DbTransaction, stream: LiveSourceStream, state: 'gap' | 'quarantined', issue: NonNullable<LiveSourceStream['lastIssue']>, now: number): Promise<SourceApplyResult> {
    const [next] = await tx.update(copyLiveSourceStreams).set({ state, lastIssue: issue, revision: stream.revision + 1, updatedAt: new Date(now) })
      .where(and(eq(copyLiveSourceStreams.id, stream.id), eq(copyLiveSourceStreams.revision, stream.revision))).returning();
    if (!next) throw new LiveBoundaryError('live_source_cas_lost');
    // Return rather than throw so the caller commits the durable quarantine.
    return { kind: state === 'quarantined' ? 'quarantined' : 'recorded', stream: next };
  }
  async fills(leader: string) {
    const rows = await this.db.select().from(copyLiveSourceFills).where(eq(copyLiveSourceFills.streamId, `testnet:${address(leader)}`)).limit(10001);
    if (rows.length > 10000) throw new LiveBoundaryError('live_source_read_unbounded');
    return rows.map(decodeLiveSourceFill).sort((a,b) => a.providerTime - b.providerTime || (BigInt(a.tid) < BigInt(b.tid) ? -1 : BigInt(a.tid) > BigInt(b.tid) ? 1 : 0));
  }
}
