import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppConfig } from '../../config/app-config.js';
import { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { COPY_LEADER_TRADED_EVENT, COPY_LEADER_VERIFIED_EVENT, type CopyLeaderTradedEvent, type CopyLeaderVerifiedEvent } from '../../watcher/copy-leader-events.js';
import { safeErrorText, type CopyLiveEngine } from './copy-live-engine.js';
import { LIVE_ENGINE } from './copy-live-engine.provider.js';

/**
 * Worker loop: one engine pass every COPY_LIVE_INTERVAL_MS, never two at once.
 * Off unless COPY_TRADING_MODE is testnet or live, and under NODE_ENV=test.
 *
 * Fast source: a feed trade schedules a kick for when its fill can be certified
 * (G after the trade); kicks never overlap a pass. A watcher verification
 * queues an audit of the leader's stream.
 *
 * One read per leader per G window: a trade witnessed while a kick is
 * scheduled joins it (the earlier due time stands), one witnessed while the
 * leader's read is in flight is left to that read's follow-up (the read
 * returns every trade before its `to`; what it could not certify yet is
 * read next, G later at the earliest), and a kick due within G of the last
 * read is moved to G after it (engine.nextReadAt). Before 2026-10-17 a trade
 * that arrived during a read brought one more read right after it, and a
 * kick due within G of a read was read then: one read per witnessed trade
 * at a high trade rate (Stage: one leader held 341 p50 / 580 p95 of the
 * shared window).
 */
@Injectable()
export class CopyLiveWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyLiveWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private testnetPolling = false;
  private started = false;
  /** The regular pass is due and not run yet. */
  private passDue = false;
  private lastPassAt = 0;
  private intervalMs = 3000;
  /** Leaders due a kick, and those due an audit, run after the work in flight. */
  private readonly kicks = new Set<string>();
  private readonly audits = new Set<string>();
  private readonly scheduled = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly signalling = new Set<string>();
  /** The earliest feed trade each scheduled read is for (timing logs). */
  private readonly trades = new Map<string, { tid: number; time: number; seenAt: number }>();
  constructor(private readonly config: AppConfig, private readonly jobs: BackgroundJobs, @Inject(LIVE_ENGINE) private readonly engine: CopyLiveEngine | null) {}
  onApplicationBootstrap(): void {
    const live = this.config.value.copy.live;
    if (this.config.value.app.nodeEnv === 'test' || !this.engine || !live) return;
    this.start(live.intervalMs);
    this.logger.log(`Copy execution on ${live.network} every ${live.intervalMs} ms${live.allowedPrivyUserIds ? ` for ${live.allowedPrivyUserIds.size} listed owner(s)` : ''}${live.fastSource ? `; fast source for ${live.fastSource.leaders === 'all' ? 'every mainnet leader' : [...live.fastSource.leaders].join(', ')} (G ${live.fastSource.graceMs} ms)` : ''}`);
  }
  /** Starts the passes and accepts kicks (tests call it directly). */
  start(intervalMs: number): void {
    this.started = true; this.intervalMs = intervalMs; this.lastPassAt = Date.now();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }
  onModuleDestroy(): void {
    this.started = false;
    clearInterval(this.timer);
    for (const { timer } of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
  }

  @OnEvent(COPY_LEADER_TRADED_EVENT)
  onLeaderTraded(event: CopyLeaderTradedEvent): void {
    if (!this.started || !this.engine) return;
    const at = this.engine.witness(event.address, event.tid, event.time);
    if (at === null) return;
    const first = this.trades.get(event.address);
    if (!first || event.time < first.time) this.trades.set(event.address, { tid: event.tid, time: event.time, seenAt: Date.now() });
    this.schedule(event.address, at);
  }
  @OnEvent(COPY_LEADER_VERIFIED_EVENT)
  onLeaderVerified(event: CopyLeaderVerifiedEvent): void {
    if (!this.started || !this.engine) return;
    this.audits.add(event.address);
    void this.drain();
  }

  /** One kick of `leader` at `at` (the earlier of two requests wins). */
  private schedule(leader: string, at: number): void {
    const held = this.scheduled.get(leader);
    if (held && held.at <= at) return;
    if (held) clearTimeout(held.timer);
    const timer = setTimeout(() => {
      this.scheduled.delete(leader);
      void this.signal(leader);
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.scheduled.set(leader, { at, timer });
  }

  /** Signal half runs at once (one per leader); the order half joins the queue. */
  private async signal(leader: string): Promise<void> {
    if (!this.engine || this.jobs.stopping) return;
    // A read in flight: its follow-up reads what it could not certify (no read of this kick's own).
    if (this.signalling.has(leader)) return;
    // Due within G of the leader's last read: moved to G after it.
    const notBefore = this.engine.nextReadAt(leader);
    if (notBefore > Date.now()) { this.schedule(leader, notBefore); return; }
    this.signalling.add(leader);
    const engine = this.engine;
    const trade = this.trades.get(leader), scheduledAt = Date.now();
    this.trades.delete(leader);
    try {
      const timing = await this.jobs.run(() => engine.signal(leader));
      if (timing) {
        this.kicks.add(leader); void this.drain();
        // trade time -> feed seen -> read asked / left / answered -> ingested -> enqueued (ms after the trade).
        if (trade) {
          const after = (at: number | undefined) => at === undefined ? '-' : `+${at - trade.time}`;
          this.logger.log(`Copy signal ${leader} trade ${trade.tid}: seen ${after(trade.seenAt)}, read due ${after(scheduledAt)}, asked ${after(timing.read?.asked)}, ` +
            `left ${after(timing.read?.sentAt)}, answered ${after(timing.read?.answeredAt)}, ingested ${after(timing.ingestedAt)} ` +
            `(${timing.ingest ? `${timing.ingest.fast ? 'fast' : 'watched'} ${timing.ingest.fills} fill(s), ${timing.ingest.kind}, ${timing.ingest.state}, through ${after(timing.ingest.through ?? undefined)}` : 'no read'}), enqueued ${after(timing.enqueuedAt)}`);
        }
      }
    } catch (error) { this.logger.error(`Copy signal of ${leader} failed: ${safeErrorText(error)}`); }
    finally {
      this.signalling.delete(leader);
      const next = engine.followUp(leader);
      if (next !== null) this.schedule(leader, next);
    }
  }

  /** Marks the pass due; it runs ahead of waiting kicks so they can't starve it. */
  async tick(): Promise<void> {
    if (this.jobs.stopping || !this.engine) return;
    this.passDue = true;
    // While a pass waits on quota, keep ingesting testnet signals; order work stays serial.
    if (this.started && this.running && !this.testnetPolling && this.config.value.copy.live?.network === 'testnet') {
      this.testnetPolling = true;
      try { await this.jobs.run(() => this.engine!.pollTestnetSources()); }
      catch (error) { this.logger.error(`Testnet source poll failed: ${safeErrorText(error)}`); }
      finally { this.testnetPolling = false; }
    }
    await this.drain();
  }

  /** Runs work one at a time: a due pass first, then kicks, then audits. */
  private async drain(): Promise<void> {
    if (this.running || this.jobs.stopping || !this.engine) return;
    this.running = true;
    const engine = this.engine;
    try {
      while (!this.jobs.stopping && (this.passDue || this.kicks.size || this.audits.size)) {
        if (this.passDue || Date.now() - this.lastPassAt >= this.intervalMs) {
          this.passDue = false; this.lastPassAt = Date.now();
          try { await this.jobs.run(() => engine.tick()); }
          catch (error) { this.logger.error(`Testnet copy pass failed: ${safeErrorText(error)}`); }
          continue;
        }
        const [leader] = this.kicks;
        if (leader !== undefined) {
          this.kicks.delete(leader);
          try { await this.jobs.run(() => engine.workLeader(leader)); }
          catch (error) { this.logger.error(`Copy kick of ${leader} failed: ${safeErrorText(error)}`); }
          continue;
        }
        const [audited] = this.audits;
        if (audited !== undefined) {
          this.audits.delete(audited);
          try {
            const missed = await this.jobs.run(() => engine.audit(audited));
            if (missed.length) this.logger.error(`Copy source audit: ${missed.length} fill(s) of ${audited} were missed by the copy stream`);
          } catch (error) { this.logger.error(`Copy source audit of ${audited} failed: ${safeErrorText(error)}`); }
        }
      }
    } finally { this.running = false; }
  }
}
