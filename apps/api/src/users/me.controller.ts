import { ApiDoc } from "../common/decorators/http.decorator.js";
import { PatchMeDto, PatchFavoriteAlertDto } from "./dto/profile.dto.js";
import { AddressParamsDto } from "../common/dto/params.dto.js";
import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, HttpStatus, Param, Patch, Put } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import { type Favorite, type MeResponse } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { AccountDeletionService } from "./account-deletion.service.js";
import { FavoritesService } from "./favorites.service.js";
import { ProfileService } from "./profile.service.js";


/** The header, and its only accepted value, that confirm DELETE /me. */
export const ACCOUNT_DELETION_HEADER = "x-confirm-delete";
export const ACCOUNT_DELETION_CONFIRMATION = "delete-account";

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

  /** Deletes the caller's Orbie account (docs/account-deletion.md): personal
   * data is erased, kept financial and audit records move to an anonymous
   * tombstone. The Privy login and wallets are not touched. 409 with the
   * blocker's code while something is in flight (a testnet copy, a stop, a
   * setup, a transfer, an order, a non-empty copy account, a withdrawal or a
   * reward claim), `last_admin` for the only enabled admin; 503
   * `closure_check_unavailable` when a copy account can't be checked. A
   * valid token alone is not enough: the request must
   * carry `X-Confirm-Delete: delete-account`, which the settings page sends
   * only after the person typed the confirmation word (428
   * `confirmation_required` otherwise; audit C). */
  @ApiDoc("Delete my account", "Deletes the Orbie account and its personal data; kept financial and audit records are anonymised and purged after 365 days. Only in-flight state blocks it (409 with the blocker's code). The Privy wallets and funds are not affected. Requires the X-Confirm-Delete header.")
  @ApiHeader({ name: ACCOUNT_DELETION_HEADER, required: true, description: `Must be "${ACCOUNT_DELETION_CONFIRMATION}": the explicit confirmation of the person deleting their account.` })
  @Delete()
  @HttpCode(204)
  async deleteMe(@CurrentUser() user: RequestUser | null, @Headers(ACCOUNT_DELETION_HEADER) confirmation?: string, @Headers("authorization") authorization?: string): Promise<void> {
    const userId = requireUserId(user);
    if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
      throw new HttpException({ statusCode: HttpStatus.PRECONDITION_REQUIRED, code: "confirmation_required", message: "Confirm the account deletion" }, HttpStatus.PRECONDITION_REQUIRED);
    }
    // The bearer is the owner's Privy session: it takes the worker off a
    // copy wallet's signers (automatic return) before the account goes.
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : undefined;
    await this.deletion.delete(userId, bearer || undefined);
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
