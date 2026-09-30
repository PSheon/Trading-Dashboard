import { Module } from "@nestjs/common";

import { NotifyService } from "./notify.service.js";
import { TelegramHttpClient } from "./telegram-http.client.js";
import { NotifyRepository } from "./notify.repository.js";

@Module({
  providers: [NotifyRepository, NotifyService, TelegramHttpClient],
  exports: [NotifyService, TelegramHttpClient],
})
export class NotifyModule {}
