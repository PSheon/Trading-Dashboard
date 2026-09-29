import { Module } from "@nestjs/common";

import { NotifyService } from "./notify.service.js";
import { TelegramHttpClient } from "./telegram-http.client.js";

@Module({
  providers: [NotifyService, TelegramHttpClient],
  exports: [NotifyService, TelegramHttpClient],
})
export class NotifyModule {}
