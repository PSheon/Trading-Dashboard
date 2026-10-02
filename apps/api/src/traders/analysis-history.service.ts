import { Injectable, Logger, Optional } from "@nestjs/common";
import { advanceCheckpoint, initialCheckpoint, planRange, type ArchiveSpan, type HistoryCheckpoint, type HistorySource } from "../analytics/history-checkpoint.js";
import { AppConfig } from "../config/app-config.js";
import { HyperliquidInfoClient, twapSliceToFill } from "../hyperliquid/hyperliquid-info.client.js";
import { UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { AnalysisHistoryRepository, type HistoryCaller, type HistoryJob } from "./analysis-history.repository.js";

/** At most two range pages per minute (~240 weight). Uses the existing
 * global budgeter, behind page requests. No detached notification work. */
export const HISTORY_PAGES_PER_TICK = 2;
/** Jobs nobody asks for any more are looked for this often. */
const EXPIRE_EVERY_MS = 3_600_000;
@Injectable()
export class AnalysisHistoryService {
  private readonly logger = new Logger(AnalysisHistoryService.name);
  private running: Promise<string | undefined> | undefined;
  private turns = 0;
  private expiredAt = 0;
  constructor(
    private readonly repository: AnalysisHistoryRepository,
    private readonly info: HyperliquidInfoClient,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() private readonly config?: AppConfig,
  ) {}
  /** REST streams allowed to skip archive-certified ranges (`S3_ARCHIVE_TRUST`):
   * for those the stored fills of the span stand in for the REST read. */
  trusts(source: HistorySource): boolean {
    const trust = this.config?.value.archive.trust ?? "regular";
    return trust === "all" || (trust === "regular" && source === "regular");
  }
  archiveSpan(address: string) { return this.repository.archiveSpan(address); }
  archivedFills(address: string, span: ArchiveSpan) { return this.repository.archivedFills(address, span); }
  recentFills(address: string, source: HistorySource, span: ArchiveSpan, limit: number) { return this.repository.recentFills(address, source, span, limit); }
  /**
   * Runs the address's history job now, up to `maxPages` REST pages, when
   * the archive already holds most of its history (so the job is a few
   * calls, not a scan). Returns whether a published snapshot exists after.
   */
  async catchUp(address: string, maxPages: number, cost?: { calls: number; weight: number; rank?: number }): Promise<boolean> {
    if (!(await this.repository.archiveSpan(address))) return false;
    await this.repository.ensure(address);
    for (let used = 0; used < maxPages && !this.jobs.stopping;) {
      const job = await this.repository.state(address);
      if (!job || job.status !== "pending") return Boolean(job?.publishedThrough);
      const pages = await this.advance(job, Date.now(), Math.min(HISTORY_PAGES_PER_TICK, maxPages - used), cost);
      if (pages === 0) break;
      used += pages;
    }
    const job = await this.repository.state(address);
    return job?.status === "caught_up" && Boolean(job.publishedThrough);
  }
  /** Whether the address has a durable job afterwards; see the repository for who may create one. */
  ensure(address: string, from?: number, caller: HistoryCaller = "product") { return this.repository.ensure(address, Date.now(), from, caller); }
  preserve(address: string, fills: HlUserFill[]) { return this.repository.preserve(address, fills); }
  snapshot(address: string) { return this.repository.snapshot(address); }
  async status(address: string) {
    const job = await this.repository.state(address);
    return job ? {
      status: job.status,
      reason: job.checkpoint.reason ?? (job.lastError ? "upstream_unavailable" as const : null),
      regular: job.checkpoint.sources.regular.status,
      twap: job.checkpoint.sources.twap.status,
      retentionLimited: true as const,
    } : undefined;
  }
  tick(): Promise<string | undefined> {
    if (this.jobs.stopping) return Promise.resolve(undefined);
    this.running ??= this.jobs.run(async () => {
      if (Date.now() - this.expiredAt > EXPIRE_EVERY_MS) {
        this.expiredAt = Date.now();
        const removed = await this.repository.expire().catch(() => 0);
        if (removed > 0) this.logger.log(`History: ${removed} job(s) nobody asked for in 14 days removed, with their fills`);
      }
      // Every other turn goes to a job already in progress (or due for its
      // refresh), so new jobs can't hold the whole queue.
      const job = await this.repository.claim(Date.now(), this.turns++ % 2 === 1);
      if (!job) return undefined;
      await this.advance(job);
      const updated = await this.repository.state(job.address);
      return updated?.publishedThrough && updated.publishedThrough.getTime() !== job.publishedThrough?.getTime() ? job.address : undefined;
    }).catch((error: Error) => {
      this.logger.warn(`History worker failed: ${error.name}`);
      return undefined;
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  /** Advances one job by at most `maxPages` REST pages; ranges the archive
   * certifies cost no request. Returns the pages read. */
  async advance(initial: HistoryJob, now = Date.now(), maxPages = HISTORY_PAGES_PER_TICK, cost?: { calls: number; weight: number; rank?: number }): Promise<number> {
    let job = initial;
    if (job.status === "blocked") return 0;
    const span = await this.repository.archiveSpan(job.address);
    // The scheduled job yields to every page; a page-driven catch-up passes its own rank.
    const rank = cost?.rank ?? UNRANKED_BASE;
    let pages = 0;
    // Each source needs at most a jump and a page per round; the bound only guards a logic error.
    for (let step = 0; step < maxPages * 4 + 4 && pages < maxPages && !this.jobs.stopping; step++) {
      const checkpoint: HistoryCheckpoint = job.status === "caught_up"
        ? initialCheckpoint(Math.max(now, job.checkpoint.until), job.checkpoint.until)
        : job.checkpoint;
      const source = (["regular", "twap"] as HistorySource[])
        .filter(s => checkpoint.sources[s].status === "pending")
        .sort((a, b) => (checkpoint.sources[a].through ?? -1) - (checkpoint.sources[b].through ?? -1))[0];
      if (!source) break;
      try {
        const plan = planRange(checkpoint, source, this.trusts(source) ? span : null);
        let batch: HlUserFill[] = [];
        let next = plan.checkpoint;
        if (plan.start !== null) {
          batch = source === "regular"
            ? await this.info.userFillsByTime(job.address, plan.start, plan.end, "background", rank)
            : (await this.info.userTwapSliceFillsByTime(job.address, plan.start, plan.end, "background", rank)).map(twapSliceToFill);
          pages += 1;
          if (cost) {
            cost.calls += 1;
            cost.weight += 20 + Math.ceil(batch.length / 20);
          }
          next = advanceCheckpoint(plan.checkpoint, source, batch, plan.end);
        }
        const saved = await this.repository.commit(job, source, batch, next);
        if (!saved) return pages;
        job = saved;
        if (job.status !== "pending") break;
      } catch (error) {
        await this.repository.failure(job);
        throw error;
      }
    }
    return pages;
  }
}
