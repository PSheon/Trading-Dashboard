import { ProfileRepository } from "./profile.repository.js";
import { FavoritesRepository } from "./favorites.repository.js";
import { Module } from "@nestjs/common";

import { IngestionModule } from "../watcher/ingestion.module.js";
import { FavoritesService } from "./favorites.service.js";
import { FavoriteGroupsController } from "./favorite-groups.controller.js";
import { FavoriteGroupsRepository } from "./favorite-groups.repository.js";
import { FavoriteGroupsService } from "./favorite-groups.service.js";
import { AccountDeletionService } from "./account-deletion.service.js";
import { AccountRepository } from "./account.repository.js";
import { MeController } from "./me.controller.js";
import { ProfileService } from "./profile.service.js";

/** /me/*: profile, account deletion, favorites, their groups and Telegram alerts. */
@Module({
  imports: [IngestionModule],
  controllers: [MeController, FavoriteGroupsController],
  providers: [AccountRepository, AccountDeletionService, ProfileRepository, FavoritesRepository, ProfileService, FavoritesService, FavoriteGroupsRepository, FavoriteGroupsService],
  exports: [FavoritesService],
})
export class UsersModule {}
