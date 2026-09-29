import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Put } from "@nestjs/common";
import {
  addressSchema,
  patchFavoriteAlertRequestSchema,
  patchMeRequestSchema,
  type Favorite,
  type MeResponse,
} from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { FavoritesService } from "./favorites.service.js";
import { ProfileService } from "./profile.service.js";
import { parseOr400 } from "../common/http/validation.js";

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
  patchMe(@CurrentUser() user: RequestUser | null, @Body() body: unknown): Promise<MeResponse> {
    const userId = requireUserId(user);
    return this.profile.patch(userId, parseOr400(patchMeRequestSchema, body ?? {}));
  }

  @Get("favorites")
  listFavorites(@CurrentUser() user: RequestUser | null): Promise<Favorite[]> {
    return this.favorites.list(requireUserId(user));
  }

  @Put("favorites/:address")
  addFavorite(@CurrentUser() user: RequestUser | null, @Param("address") address: string): Promise<Favorite> {
    const userId = requireUserId(user);
    return this.favorites.add(userId, parseOr400(addressSchema, address).toLowerCase());
  }

  /** Unfavoriting deletes the row, and its alert with it. */
  @Delete("favorites/:address")
  @HttpCode(204)
  async removeFavorite(@CurrentUser() user: RequestUser | null, @Param("address") address: string): Promise<void> {
    const userId = requireUserId(user);
    await this.favorites.remove(userId, parseOr400(addressSchema, address).toLowerCase());
  }

  @Patch("favorites/:address/alert")
  patchFavoriteAlert(
    @CurrentUser() user: RequestUser | null,
    @Param("address") address: string,
    @Body() body: unknown,
  ): Promise<Favorite> {
    const userId = requireUserId(user);
    return this.favorites.setAlert(
      userId,
      parseOr400(addressSchema, address).toLowerCase(),
      parseOr400(patchFavoriteAlertRequestSchema, body ?? {}),
    );
  }
}
