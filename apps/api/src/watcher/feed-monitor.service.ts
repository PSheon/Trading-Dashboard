import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { NotifyService } from "../notify/notify.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { TradeFeedService } from "./trade-feed.service.js";
import { FEED_DOWN_ALERT_MS } from '../config/constants/alerts.js';


/**
 * The trade feed's own schedules, beside the feed (WatcherRuntimeModule: a
 * `copy` or `all` worker): every minute the §8 self-alert when the feed has
 * been down 10 min, and hourly the subscription of newly listed markets.
 * They were SchedulerService's; a `read` worker has no feed to check.
 */
@Injectable()
export class FeedMonitorService {
  private readonly logger = new Logger(FeedMonitorService.name);
  private feedDownAlerted = false;
  private feedMissingSince: number | null = null;

  constructor(
    private readonly feed: TradeFeedService,
    private readonly notify: NotifyService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async refreshMarkets(): Promise<void> {
    if (this.jobs.stopping) return;
    try {
      await this.feed.refreshMarkets();
    } catch (error) {
      this.logger.error(`Market refresh failed: ${safeErrorText(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkFeed(now = Date.now()): Promise<void> {
    if (this.jobs.stopping) return;
    try {
      await this.checkFeedOnce(now);
    } catch (error) {
      this.logger.error(`Feed check failed: ${safeErrorText(error)}`);
    }
  }

  private async checkFeedOnce(now: number): Promise<void> {
    const status = this.feed.status();
    const down = status.socketsTotal === 0 || status.socketsOpen < status.socketsTotal;
    if (!down) {
      this.feedMissingSince = null;
      if (this.feedDownAlerted) {
        this.feedDownAlerted = false;
        await this.notify.sendSystemMessage("✅ Trade feed recovered; missed fills are being swept.");
      }
      return;
    }
    const since = status.disconnectedSince?.getTime() ?? (this.feedMissingSince ??= now);
    if (!this.feedDownAlerted && now - since >= FEED_DOWN_ALERT_MS) {
      this.feedDownAlerted = true;
      await this.notify.sendSystemMessage(
        `⚠️ Trade feed down for ${Math.round((now - since) / 60_000)} min (${status.socketsOpen}/${status.socketsTotal} sockets open). No alerts until it recovers.`,
      );
    }
  }
}
