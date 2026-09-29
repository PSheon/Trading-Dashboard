import { Module } from "@nestjs/common";

import { NotifyModule } from "../notify/notify.module.js";
import { TelegramBotService } from "./telegram-bot.service.js";
import { TelegramController } from "./telegram.controller.js";
import { TelegramLinkService } from "./telegram-link.service.js";

/** The official bot: linking chats (/me/telegram*) and its conversation. */
@Module({
  imports: [NotifyModule],
  controllers: [TelegramController],
  providers: [TelegramLinkService, TelegramBotService],
})
export class TelegramModule {}
