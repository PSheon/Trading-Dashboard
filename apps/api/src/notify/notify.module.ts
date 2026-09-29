import { Module } from "@nestjs/common";

import { AnalyticsModule } from "../analytics/analytics.module.js";
import { NotifyService } from "./notify.service.js";
import { TelegramHttpClient } from "./telegram-http.client.js";

@Module({
  imports: [AnalyticsModule],
  providers: [NotifyService, TelegramHttpClient],
  exports: [NotifyService],
})
export class NotifyModule {}
