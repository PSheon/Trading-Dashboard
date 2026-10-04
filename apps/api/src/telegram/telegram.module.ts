import { TelegramLinkRepository } from "./telegram-link.repository.js";
import { Module } from "@nestjs/common";

import { NotifyModule } from "../notify/notify.module.js";
import { TelegramBotService } from "./telegram-bot.service.js";
import { TelegramController } from "./telegram.controller.js";
import { TelegramLinkService } from "./telegram-link.service.js";

/** Linking chats to the official bot (/me/telegram*). */
@Module({
  imports: [NotifyModule],
  controllers: [TelegramController],
  providers: [TelegramLinkRepository, TelegramLinkService],
  exports: [TelegramLinkService],
})
export class TelegramModule {}

/** The bot's conversation (long polling `getUpdates`): the worker process
 * only, since Telegram allows one poller per token. */
@Module({ imports: [TelegramModule, NotifyModule], providers: [TelegramBotService] })
export class TelegramWorkerModule {}
