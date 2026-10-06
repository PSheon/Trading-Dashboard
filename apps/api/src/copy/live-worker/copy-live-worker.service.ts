import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppConfig } from '../../config/app-config.js';
import { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { COPY_LEADER_TRADED_EVENT, COPY_LEADER_VERIFIED_EVENT, type CopyLeaderTradedEvent, type CopyLeaderVerifiedEvent } from '../../watcher/copy-leader-events.js';
import { safeErrorText, type CopyLiveEngine } from './copy-live-engine.js';
import { LIVE_ENGINE } from './copy-live-engine.provider.js';

/**
 * Drives testnet copy execution in the worker process: one engine pass every
 * COPY_LIVE_INTERVAL_MS (default 3 s), never two at once. Off unless
 * COPY_TRADING_MODE=testnet, and under NODE_ENV=test. Paper copies keep their
 * own loop (CopyWorkerService). Shutdown drains the pass in flight.
 *
 * Realtime signal (COPY_LIVE_FAST_SOURCE): a feed trade of a fast-source
 * leader schedules a kick of that leader for when its fill can be certified
 * (G after the trade). A kick runs at once, or right after the work in
 * flight; it never overlaps a pass. After the watcher verifies a leader,
 * its stream is audited the same way.
 */
@Injectable()
export class CopyLiveWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyLiveWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private started = false;
  /** The regular pass was asked for (its interval came round) and not run yet. */
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
  private readonly resignal = new Set<string>();
  constructor(private readonly config: AppConfig, private readonly jobs: BackgroundJobs, @Inject(LIVE_ENGINE) private readonly engine: CopyLiveEngine | null) {}
  onApplicationBootstrap(): void {
    const live = this.config.value.copy.live;
    if (this.config.value.app.nodeEnv === 'test' || !this.engine || !live) return;
    this.start(live.intervalMs);
    this.logger.log(`Testnet copy execution every ${live.intervalMs} ms${live.fastSource ? `; fast source for ${live.fastSource.leaders === 'all' ? 'every mainnet leader' : [...live.fastSource.leaders].join(', ')} (G ${live.fastSource.graceMs} ms)` : ''}`);
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

  /** A kick's signal half runs at once, beside a pass or an order in flight
   * (one per leader at a time); its order half joins the queue. */
  private async signal(leader: string): Promise<void> {
    if (!this.engine || this.jobs.stopping) return;
    if (this.signalling.has(leader)) { this.resignal.add(leader); return; }
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
      if (this.resignal.delete(leader)) void this.signal(leader);
    }
  }

  /** The regular pass is due every interval: when other work is running it
   * goes next, ahead of any kick waiting (it runs setups, activations, every
   * other leader's reads and the stops, so kicks can never starve it). */
  async tick(): Promise<void> {
    if (this.jobs.stopping || !this.engine) return;
    this.passDue = true;
    await this.drain();
  }

  /** Runs the due pass, kicks and audits one at a time: the pass first
   * whenever it is due (every interval), then kicks, then audits. */
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
