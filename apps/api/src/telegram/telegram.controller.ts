import { Controller, Delete, Get, HttpCode, Post } from "@nestjs/common";
import type { TelegramLinkResponse, TelegramStatus, TelegramTestResponse } from "@trading-dashboard/shared";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { requireUserId } from "../users/validation.js";
import { TelegramLinkService } from "./telegram-link.service.js";

/** The signed-in user's Telegram link to the official bot. */
@Controller("me/telegram")
export class TelegramController {
  constructor(private readonly link: TelegramLinkService) {}

  @Get()
  status(@CurrentUser() user: RequestUser | null): Promise<TelegramStatus> {
    return this.link.status(requireUserId(user));
  }

  /** A one-time t.me deep link; 503 `telegram_not_configured` without a
   * bot, 429 beyond 5 per 10 minutes. */
  @Post("link")
  @HttpCode(200)
  createLink(@CurrentUser() user: RequestUser | null): Promise<TelegramLinkResponse> {
    return this.link.createLink(requireUserId(user));
  }

  @Delete()
  @HttpCode(204)
  async unlink(@CurrentUser() user: RequestUser | null): Promise<void> {
    await this.link.unlink(requireUserId(user));
  }

  /** 409 `telegram_not_linked` without a linked, enabled chat. */
  @Post("test")
  @HttpCode(200)
  sendTest(@CurrentUser() user: RequestUser | null): Promise<TelegramTestResponse> {
    return this.link.sendTest(requireUserId(user));
  }
}
