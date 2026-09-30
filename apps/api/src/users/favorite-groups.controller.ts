import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import {
  CurrentUser,
  requireUserId,
  type RequestUser,
} from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { FavoriteGroupsRepository } from "./favorite-groups.repository.js";
import {
  FavoriteGroupIdDto,
  FavoriteGroupInputDto,
  FavoriteGroupMemberDto,
  FavoriteGroupPatchDto,
} from "./dto/favorite-groups.dto.js";
@Controller("me/favorite-groups")
export class FavoriteGroupsController {
  constructor(private readonly groups: FavoriteGroupsRepository) {}
  @Get()
  @Header("Cache-Control", "no-store")
  @ApiDoc("List own private favorite groups")
  list(@CurrentUser() user: RequestUser | null) {
    return this.groups.list(requireUserId(user));
  }
  @Post()
  @ApiDoc("Create a private favorite group", "409 group_name_exists (case-insensitive) or group_limit past 20 groups.")
  create(
    @CurrentUser() user: RequestUser | null,
    @Body() body: FavoriteGroupInputDto,
  ) {
    return this.groups.save(requireUserId(user), body);
  }
  @Patch(":id")
  @ApiDoc("Rename, recolour or reorder own favorite group")
  rename(
    @CurrentUser() user: RequestUser | null,
    @Param() params: FavoriteGroupIdDto,
    @Body() body: FavoriteGroupPatchDto,
  ) {
    return this.groups.save(requireUserId(user), body, params.id);
  }
  @Delete(":id")
  @HttpCode(204)
  @ApiDoc("Delete own group while retaining favorites")
  remove(
    @CurrentUser() user: RequestUser | null,
    @Param() params: FavoriteGroupIdDto,
  ) {
    return this.groups.remove(requireUserId(user), params.id);
  }
  @Put(":id/members/:address")
  @HttpCode(204)
  @ApiDoc("Add an owned favorite to an owned group")
  add(
    @CurrentUser() user: RequestUser | null,
    @Param() params: FavoriteGroupMemberDto,
  ) {
    return this.groups.member(
      requireUserId(user),
      params.id,
      params.address,
      true,
    );
  }
  @Delete(":id/members/:address")
  @HttpCode(204)
  @ApiDoc("Remove favorite group membership")
  ungroup(
    @CurrentUser() user: RequestUser | null,
    @Param() params: FavoriteGroupMemberDto,
  ) {
    return this.groups.member(
      requireUserId(user),
      params.id,
      params.address,
      false,
    );
  }
}
