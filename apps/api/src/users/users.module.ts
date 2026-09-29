import { ProfileRepository } from "./profile.repository.js";
import { FavoritesRepository } from "./favorites.repository.js";
import { Module } from "@nestjs/common";

import { IngestionModule } from "../watcher/ingestion.module.js";
import { FavoritesService } from "./favorites.service.js";
import { MeController } from "./me.controller.js";
import { ProfileService } from "./profile.service.js";

/** /me/*: profile, favorites and their Telegram alerts. */
@Module({
  imports: [IngestionModule],
  controllers: [MeController],
  providers: [ProfileRepository, FavoritesRepository, ProfileService, FavoritesService],
  exports: [FavoritesService],
})
export class UsersModule {}
