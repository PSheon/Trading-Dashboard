import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppConfig } from '../../config/app-config.js';
import { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { COPY_LEADER_TRADED_EVENT, COPY_LEADER_VERIFIED_EVENT, type CopyLeaderTradedEvent, type CopyLeaderVerifiedEvent } from '../../watcher/copy-leader-events.js';
import type { CopyLiveEngine } from './copy-live-engine.js';
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
  /** Leaders due a kick, and those due an audit, run after the work in flight. */
  private readonly kicks = new Set<string>();
  private readonly audits = new Set<string>();
  private readonly scheduled = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly config: AppConfig, private readonly jobs: BackgroundJobs, @Inject(LIVE_ENGINE) private readonly engine: CopyLiveEngine | null) {}
  onApplicationBootstrap(): void {
    const live = this.config.value.copy.live;
    if (this.config.value.app.nodeEnv === 'test' || !this.engine || !live) return;
    this.start(live.intervalMs);
    this.logger.log(`Testnet copy execution every ${live.intervalMs} ms${live.fastSource ? `; fast source for ${live.fastSource.leaders === 'all' ? 'every mainnet leader' : [...live.fastSource.leaders].join(', ')} (G ${live.fastSource.graceMs} ms)` : ''}`);
  }
  /** Starts the passes and accepts kicks (tests call it directly). */
  start(intervalMs: number): void {
    this.started = true;
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
    if (at !== null) this.schedule(event.address, at);
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
      this.kicks.add(leader);
      void this.drain();
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.scheduled.set(leader, { at, timer });
  }

  /** The regular pass; skipped while other work runs (the next tick comes soon). */
  async tick(): Promise<void> {
    if (this.running || this.jobs.stopping || !this.engine) return;
    await this.drain(true);
  }

  /** Runs due kicks and audits, and a pass when asked, one at a time. */
  private async drain(pass = false): Promise<void> {
    if (this.running || this.jobs.stopping || !this.engine) return;
    this.running = true;
    const engine = this.engine;
    try {
      while (!this.jobs.stopping && (pass || this.kicks.size || this.audits.size)) {
        const [leader] = this.kicks;
        if (leader !== undefined) {
          this.kicks.delete(leader);
          try { await this.jobs.run(() => engine.kick(leader)); }
          catch (error) { this.logger.error(`Copy kick of ${leader} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}`); }
          const next = engine.followUp(leader);
          if (next !== null) this.schedule(leader, next);
          continue;
        }
        const [audited] = this.audits;
        if (audited !== undefined) {
          this.audits.delete(audited);
          try {
            const missed = await this.jobs.run(() => engine.audit(audited));
            if (missed.length) this.logger.error(`Copy source audit: ${missed.length} fill(s) of ${audited} were missed by the copy stream`);
          } catch (error) { this.logger.error(`Copy source audit of ${audited} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}`); }
          continue;
        }
        pass = false;
        try { await this.jobs.run(() => engine.tick()); }
        catch (error) { this.logger.error(`Testnet copy pass failed: ${error instanceof Error ? error.message : 'unknown'}`); }
      }
    } finally { this.running = false; }
  }
}
