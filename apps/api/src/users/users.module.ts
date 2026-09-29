import { Module } from "@nestjs/common";

import { WatcherModule } from "../watcher/watcher.module.js";
import { FavoritesService } from "./favorites.service.js";
import { MeController } from "./me.controller.js";
import { NotificationChannelsService } from "./notification-channels.service.js";
import { ProfileService } from "./profile.service.js";
import { UserAlertRulesService } from "./user-alert-rules.service.js";

/** /me/*: profile, favorites, notification channels, own alert rules. */
@Module({
  imports: [WatcherModule],
  controllers: [MeController],
  providers: [ProfileService, FavoritesService, NotificationChannelsService, UserAlertRulesService],
  exports: [FavoritesService],
})
export class UsersModule {}
