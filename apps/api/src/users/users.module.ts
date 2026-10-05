import { FavoriteGroupsController } from "./favorite-groups.controller.js";
import { FavoriteGroupsRepository } from "./favorite-groups.repository.js";
import { ProfileRepository } from "./profile.repository.js";
import { FavoritesRepository } from "./favorites.repository.js";
import { Module } from "@nestjs/common";

import { CopyModule } from "../copy/copy.module.js";
import { IngestionModule } from "../watcher/ingestion.module.js";
import { FavoritesService } from "./favorites.service.js";
import { AccountDeletionService } from "./account-deletion.service.js";
import { AccountRepository } from "./account.repository.js";
import { MeController } from "./me.controller.js";
import { ProfileService } from "./profile.service.js";

/** /me/*: profile, account deletion, favorites, their groups and Telegram alerts. */
@Module({
  // CopyModule: account deletion's copy-account checks (COPY_ACCOUNT_CLOSURE).
  imports: [IngestionModule, CopyModule],
  controllers: [FavoriteGroupsController, MeController],
  providers: [FavoriteGroupsRepository, AccountRepository, AccountDeletionService, ProfileRepository, FavoritesRepository, ProfileService, FavoritesService],
  exports: [FavoritesService],
})
export class UsersModule {}
