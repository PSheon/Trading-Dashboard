import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import type { FavoriteGroup } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc, ResponseMessage } from "../common/decorators/http.decorator.js";
import { CreateFavoriteGroupDto, FavoriteGroupMemberParamsDto, FavoriteGroupParamsDto, PatchFavoriteGroupDto } from "./dto/favorite-groups.dto.js";
import { FavoriteGroupsService } from "./favorite-groups.service.js";

/** /me/favorite-groups: the signed-in user's favorites groups (收藏群組). */
@Controller("me/favorite-groups")
export class FavoriteGroupsController {
  constructor(private readonly groups: FavoriteGroupsService) {}

  @ApiDoc("List favorite groups")
  @Get()
  list(@CurrentUser() user: RequestUser | null): Promise<FavoriteGroup[]> {
    return this.groups.list(requireUserId(user));
  }

  @ResponseMessage("Group created")
  @ApiDoc("Create a favorite group", "409 group_exists for a duplicate name, group_limit past 20 groups.")
  @Post()
  create(@CurrentUser() user: RequestUser | null, @Body() body: CreateFavoriteGroupDto): Promise<FavoriteGroup> {
    return this.groups.create(requireUserId(user), { name: body.name, color: body.color });
  }

  @ApiDoc("Rename, recolour or reorder a favorite group")
  @Patch(":id")
  patch(@CurrentUser() user: RequestUser | null, @Param() params: FavoriteGroupParamsDto, @Body() body: PatchFavoriteGroupDto): Promise<FavoriteGroup> {
    return this.groups.patch(requireUserId(user), params.id, { name: body.name, color: body.color, sortOrder: body.sortOrder });
  }

  /** The favorites themselves stay. */
  @ApiDoc("Delete a favorite group")
  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser | null, @Param() params: FavoriteGroupParamsDto): Promise<void> {
    await this.groups.remove(requireUserId(user), params.id);
  }

  @ApiDoc("Add a favorite to a group")
  @Put(":id/members/:address")
  addMember(@CurrentUser() user: RequestUser | null, @Param() params: FavoriteGroupMemberParamsDto): Promise<FavoriteGroup> {
    return this.groups.addMember(requireUserId(user), params.id, params.address);
  }

  @ApiDoc("Remove a favorite from a group")
  @Delete(":id/members/:address")
  @HttpCode(204)
  async removeMember(@CurrentUser() user: RequestUser | null, @Param() params: FavoriteGroupMemberParamsDto): Promise<void> {
    await this.groups.removeMember(requireUserId(user), params.id, params.address);
  }
}
