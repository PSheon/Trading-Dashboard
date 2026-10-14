import { Injectable, Logger, Module } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { RetentionRepository } from "./retention.repository.js";
import { RetentionService } from "./retention.service.js";
import { safeErrorText } from "../runtime/safe-error-text.js";

/** The retention capability (repository and service); schedules nothing. */
@Module({ providers: [RetentionRepository, RetentionService], exports: [RetentionService, RetentionRepository] })
class RetentionModule {}

@Injectable()
class RetentionWorker {
  private readonly logger = new Logger(RetentionWorker.name);
  constructor(private readonly retention: RetentionService) {}

  /** Three times an hour; the service runs only in its off-peak window and
   * once a day, so most ticks return at once. The retries inside the window
   * pick up a run that a deploy or a lost lease cut short. */
  @Cron("0 7,27,47 * * * *")
  async tick(): Promise<void> {
    try {
      await this.retention.tick();
    } catch (error) {
      this.logger.error(`Retention tick failed: ${safeErrorText(error)}`);
    }
  }
}

/** The retention schedule (the worker; none in tests). */
@Module({ imports: [RetentionModule], providers: [RetentionWorker] })
export class RetentionWorkerModule {}
