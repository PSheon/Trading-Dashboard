import { Module } from "@nestjs/common";

import { IngestionModule } from "../watcher/ingestion.module.js";
import { BackfillJobsModule } from "./backfill-jobs.module.js";
import { BackfillWorker } from "./backfill-worker.service.js";

/** The queued backfill jobs' loop (`read` or `all` worker; it was in
 * WatcherModule, which is now capabilities only). */
@Module({
  imports: [BackfillJobsModule, IngestionModule],
  providers: [BackfillWorker],
})
export class BackfillWorkerModule {}
