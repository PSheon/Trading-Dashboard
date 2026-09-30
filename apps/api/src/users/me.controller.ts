import { ApiDoc } from "../common/decorators/http.decorator.js";
import { PatchMeDto, PatchFavoriteAlertDto } from "./dto/profile.dto.js";
import { AddressParamsDto } from "../common/dto/params.dto.js";
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Put } from "@nestjs/common";
import { type Favorite, type MeResponse } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { AccountDeletionService } from "./account-deletion.service.js";
import { FavoritesService } from "./favorites.service.js";
import { ProfileService } from "./profile.service.js";


/** The signed-in user's own data. Not @Public: the guard returns 401
 * without a valid token; the service token gets 403 (it has no profile).
 * Telegram linking lives in telegram/telegram.controller.ts. */
@Controller("me")
export class MeController {
  constructor(
    private readonly profile: ProfileService,
    private readonly favorites: FavoritesService,
    private readonly deletion: AccountDeletionService,
  ) {}

  @ApiDoc("Get me")
  @Get()
  getMe(@CurrentUser() user: RequestUser | null): Promise<MeResponse> {
    return this.profile.get(requireUserId(user));
  }

  @ApiDoc("Patch me")
  @Patch()
  patchMe(@CurrentUser() user: RequestUser | null, @Body() body: PatchMeDto): Promise<MeResponse> {
    const userId = requireUserId(user);
    return this.profile.patch(userId, body);
  }

  /** Deletes the caller's Orbie account and everything it owns here
   * (favorites, groups, alerts, Telegram link, settings). The Privy login
   * and embedded wallet are not touched. 409 `last_admin` for the only
   * enabled admin. */
  @ApiDoc("Delete my account", "Deletes the Orbie account and its data; the Privy wallet and funds are not affected.")
  @Delete()
  @HttpCode(204)
  async deleteMe(@CurrentUser() user: RequestUser | null): Promise<void> {
    await this.deletion.delete(requireUserId(user));
  }

  @ApiDoc("List favorites")
  @Get("favorites")
  listFavorites(@CurrentUser() user: RequestUser | null): Promise<Favorite[]> {
    return this.favorites.list(requireUserId(user));
  }

  @ApiDoc("Add favorite")
  @Put("favorites/:address")
  addFavorite(@CurrentUser() user: RequestUser | null, @Param() params: AddressParamsDto): Promise<Favorite> {
    const userId = requireUserId(user);
    return this.favorites.add(userId, params.address);
  }

  /** Unfavoriting deletes the row, and its alert with it. */
  @ApiDoc("Remove favorite")
  @Delete("favorites/:address")
  @HttpCode(204)
  async removeFavorite(@CurrentUser() user: RequestUser | null, @Param() params: AddressParamsDto): Promise<void> {
    const userId = requireUserId(user);
    await this.favorites.remove(userId, params.address);
  }

  @ApiDoc("Patch favorite alert")
  @Patch("favorites/:address/alert")
  patchFavoriteAlert(
    @CurrentUser() user: RequestUser | null,
    @Param() params: AddressParamsDto,
    @Body() body: PatchFavoriteAlertDto,
  ): Promise<Favorite> {
    const userId = requireUserId(user);
    return this.favorites.setAlert(
      userId,
      params.address,
      body,
    );
  }
}
