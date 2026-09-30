import { Injectable } from "@nestjs/common";
import { AppConfig } from "../config/app-config.js";
import { FillSyncService } from "./fill-sync.service.js";

/** Worker-only initial history replay. Durable admission/status live in backfill_jobs.
 * FillSync's backfill path deduplicates persisted fills/actions and emits no live alerts. */
@Injectable()
export class BackfillService {
  constructor(private readonly config: AppConfig, private readonly fillSync: FillSyncService) {}
  async run(address: string): Promise<number> {
    if (this.config.value.app.role === "api") throw new Error("Backfill execution requires worker role");
    return (await this.fillSync.sync(address, "backfill", 0)).fetched;
  }
}
