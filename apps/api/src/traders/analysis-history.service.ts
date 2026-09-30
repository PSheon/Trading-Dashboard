import { Injectable, Logger, Optional } from "@nestjs/common";
import { advanceCheckpoint, initialCheckpoint, type HistorySource } from "../analytics/history-checkpoint.js";
import { HyperliquidInfoClient, twapSliceToFill } from "../hyperliquid/hyperliquid-info.client.js";
import { UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { AnalysisHistoryRepository, type HistoryJob } from "./analysis-history.repository.js";

/** At most two range pages per minute (~240 weight). Uses the existing
 * global budgeter, behind page requests. No detached notification work. */
export const HISTORY_PAGES_PER_TICK = 2;
@Injectable()
export class AnalysisHistoryService {
  private readonly logger = new Logger(AnalysisHistoryService.name);
  private running: Promise<string | undefined> | undefined;
  constructor(
    private readonly repository: AnalysisHistoryRepository,
    private readonly info: HyperliquidInfoClient,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}
  ensure(address: string) { return this.repository.ensure(address); }
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
      const job = await this.repository.claim();
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
  async advance(initial: HistoryJob, now = Date.now()): Promise<void> {
    let job = initial;
    if (job.status === "blocked") return;
    for (let page = 0; page < HISTORY_PAGES_PER_TICK && !this.jobs.stopping; page++) {
      const checkpoint = job.status === "caught_up"
        ? initialCheckpoint(Math.max(now, job.checkpoint.until), job.checkpoint.until)
        : job.checkpoint;
      const source = (["regular", "twap"] as HistorySource[])
        .filter(s => checkpoint.sources[s].status === "pending")
        .sort((a, b) => (checkpoint.sources[a].through ?? -1) - (checkpoint.sources[b].through ?? -1))[0];
      if (!source) break;
      try {
        const start = checkpoint.sources[source].cursor;
        const batch = source === "regular"
          ? await this.info.userFillsByTime(job.address, start, checkpoint.until, "background", UNRANKED_BASE)
          : (await this.info.userTwapSliceFillsByTime(job.address, start, checkpoint.until, "background", UNRANKED_BASE)).map(twapSliceToFill);
        const next = advanceCheckpoint(checkpoint, source, batch);
        const saved = await this.repository.commit(job, source, batch, next);
        if (!saved) return;
        job = saved;
        if (job.status !== "pending") break;
      } catch (error) {
        await this.repository.failure(job);
        throw error;
      }
    }
  }
}
