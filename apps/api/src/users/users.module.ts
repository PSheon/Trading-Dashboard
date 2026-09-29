import { Module } from "@nestjs/common";

import { WatcherModule } from "../watcher/watcher.module.js";
import { FavoritesService } from "./favorites.service.js";
import { MeController } from "./me.controller.js";
import { ProfileService } from "./profile.service.js";

/** /me/*: profile, favorites and their Telegram alerts. */
@Module({
  imports: [WatcherModule],
  controllers: [MeController],
  providers: [ProfileService, FavoritesService],
  exports: [FavoritesService],
})
export class UsersModule {}
