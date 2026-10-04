import { Injectable, Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { AppConfig } from "../config/app-config.js";
import { ArchiveIngestRepository } from "./archive-ingest.repository.js";
import { ArchiveIngestService } from "./archive-ingest.service.js";

/** The archive ingest's capability (status for `/health`, admission). */
@Module({ providers: [ArchiveIngestRepository, ArchiveIngestService], exports: [ArchiveIngestService] })
export class ArchiveIngestModule {}

@Injectable()
class ArchiveIngestWorker {
  constructor(private readonly config: AppConfig, private readonly ingest: ArchiveIngestService) {}
  /** The worker process only (the api never downloads). Off in tests. */
  @Cron(CronExpression.EVERY_MINUTE) archiveTick() {
    if (this.config.value.app.nodeEnv === "test") return;
    return this.ingest.onTick();
  }
}

/** The per-minute schedule (startup/cron stays out of the feature module). */
@Module({ imports: [ArchiveIngestModule], providers: [ArchiveIngestWorker] })
export class ArchiveIngestWorkerModule {}
