import { Injectable, Logger } from "@nestjs/common";

import { env } from "../config/env.js";

export interface TelegramNotification {
  chatId: string;
  text: string;
  /** ties this send back to an `alerts` row once persisted (N2). */
  alertId?: bigint;
}

/**
 * Telegram sender (§4.4 N1/N4). `DRY_RUN=true` (the default, per §11) must
 * make sends log-only instead of hitting the Telegram API — that branch and
 * the actual HTTP call are both left for the next task; only the shape and
 * the DRY_RUN read are wired here.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  async send(_notification: TelegramNotification): Promise<void> {
    if (env.dryRun()) {
      // TODO: still write the `alerts` row with send_status = 'dry_run'.
      this.logger.log("[DRY_RUN] notify.send called — not implemented yet");
      return;
    }
    throw new Error("not implemented");
  }

  /** N4: retries a failed send up to 3 times, then records failure. */
  async retry(_alertId: bigint): Promise<void> {
    throw new Error("not implemented");
  }
}
