import { PatchMeDto, PatchFavoriteAlertDto } from "./dto/profile.dto.js";
import { AddressParamsDto } from "../common/dto/params.dto.js";
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Put } from "@nestjs/common";
import { type Favorite, type MeResponse } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
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
  ) {}

  @Get()
  getMe(@CurrentUser() user: RequestUser | null): Promise<MeResponse> {
    return this.profile.get(requireUserId(user));
  }

  @Patch()
  patchMe(@CurrentUser() user: RequestUser | null, @Body() body: PatchMeDto): Promise<MeResponse> {
    const userId = requireUserId(user);
    return this.profile.patch(userId, body);
  }

  @Get("favorites")
  listFavorites(@CurrentUser() user: RequestUser | null): Promise<Favorite[]> {
    return this.favorites.list(requireUserId(user));
  }

  @Put("favorites/:address")
  addFavorite(@CurrentUser() user: RequestUser | null, @Param() params: AddressParamsDto): Promise<Favorite> {
    const userId = requireUserId(user);
    return this.favorites.add(userId, params.address);
  }

  /** Unfavoriting deletes the row, and its alert with it. */
  @Delete("favorites/:address")
  @HttpCode(204)
  async removeFavorite(@CurrentUser() user: RequestUser | null, @Param() params: AddressParamsDto): Promise<void> {
    const userId = requireUserId(user);
    await this.favorites.remove(userId, params.address);
  }

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
