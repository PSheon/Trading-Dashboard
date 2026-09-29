import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Put } from "@nestjs/common";
import {
  addressSchema,
  patchMeRequestSchema,
  putTelegramChannelRequestSchema,
  type AlertRule,
  type Favorite,
  type MeResponse,
  type NotificationChannel,
} from "@trading-dashboard/shared";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { FavoritesService } from "./favorites.service.js";
import { NotificationChannelsService } from "./notification-channels.service.js";
import { ProfileService } from "./profile.service.js";
import { UserAlertRulesService } from "./user-alert-rules.service.js";
import { parseOr400, requireUserId } from "./validation.js";

/** The signed-in user's own data. Not @Public: the guard returns 401
 * without a valid token; the service token gets 403 (it has no profile). */
@Controller("me")
export class MeController {
  constructor(
    private readonly profile: ProfileService,
    private readonly favorites: FavoritesService,
    private readonly channels: NotificationChannelsService,
    private readonly rules: UserAlertRulesService,
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

  @Delete("favorites/:address")
  @HttpCode(204)
  async removeFavorite(@CurrentUser() user: RequestUser | null, @Param("address") address: string): Promise<void> {
    const userId = requireUserId(user);
    await this.favorites.remove(userId, parseOr400(addressSchema, address).toLowerCase());
  }

  @Get("notification-channels")
  listChannels(@CurrentUser() user: RequestUser | null): Promise<NotificationChannel[]> {
    return this.channels.list(requireUserId(user));
  }

  @Put("notification-channels/telegram")
  putTelegram(@CurrentUser() user: RequestUser | null, @Body() body: unknown): Promise<NotificationChannel> {
    const userId = requireUserId(user);
    return this.channels.putTelegram(userId, parseOr400(putTelegramChannelRequestSchema, body));
  }

  @Get("alert-rules")
  listRules(@CurrentUser() user: RequestUser | null): Promise<AlertRule[]> {
    return this.rules.list(requireUserId(user));
  }

  @Patch("alert-rules/:id")
  patchRule(
    @CurrentUser() user: RequestUser | null,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<AlertRule> {
    return this.rules.patch(requireUserId(user), id, body ?? {});
  }
}
