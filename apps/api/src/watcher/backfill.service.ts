import { Injectable } from "@nestjs/common";
import { FillSyncService } from "./fill-sync.service.js";

/** Windows one job run reads before handing the rest to the scheduler's
 * per-minute backfill turn (progress is in `fill_coverage`, not the job). */
const WINDOWS_PER_RUN = 6;

/** Worker-only initial history (status in backfill_jobs), read newest first
 * backward from the verified span so what is stored stays contiguous up to
 * now. Emits no live alerts. */
@Injectable()
export class BackfillService {
  constructor(private readonly fillSync: FillSyncService) {}
  async run(address: string): Promise<number> {
    let inserted = 0;
    for (let window = 0; window < WINDOWS_PER_RUN; window++) {
      const step = await this.fillSync.backfillStep(address);
      inserted += step.inserted;
      if (step.status !== "pending") break;
    }
    return inserted;
  }
}
