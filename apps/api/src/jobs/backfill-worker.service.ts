import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfig } from '../config/app-config.js';
import { BackgroundJobs } from '../runtime/background-jobs.service.js';
import { BackfillService } from '../watcher/backfill.service.js';
import { BackfillJobsRepository } from './backfill-jobs.repository.js';

@Injectable()
export class BackfillWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackfillWorker.name);
  private running = false;
  constructor(
    private readonly config: AppConfig,
    private readonly repository: BackfillJobsRepository,
    private readonly backfill: BackfillService,
    private readonly jobs: BackgroundJobs,
  ) {}
  onApplicationBootstrap() {
    if (this.config.value.app.nodeEnv !== 'test') void this.tick();
  }
  @Interval(5000)
  scheduledTick() {
    if (this.config.value.app.nodeEnv !== 'test') return this.tick();
  }

  async tick(): Promise<void> {
    if (this.jobs.stopping || this.running) return;
    this.running = true;
    try {
      await this.jobs.run(() => this.runOne());
    } catch {
      this.logger.warn(
        'Backfill worker unavailable; persisted work will be retried',
      );
    } finally {
      this.running = false;
    }
  }
  private async runOne() {
    const job = await this.repository.claim();
    if (!job) return;
    let lost = false;
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      void this.repository
        .renew(job)
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewing = false;
        });
    }, 20_000);
    renewal.unref();
    try {
      const fetched = await this.backfill.run(job.address);
      if (!lost) await this.repository.complete(job, fetched);
    } catch {
      if (!lost && !this.jobs.stopping) await this.repository.fail(job);
    } finally {
      clearInterval(renewal);
    }
  }
}
