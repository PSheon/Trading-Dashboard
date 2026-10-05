import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { Controller, Get } from "@nestjs/common";
import type { LeaderList } from "@trading-dashboard/shared/contracts";

import { RequirePermissions } from "../../common/auth/permissions.js";
import { ListsService } from "./lists.service.js";

@RequirePermissions("lists.read")
@Controller("lists")
export class ListsController {
  constructor(private readonly listsService: ListsService) {}

  @ApiDoc("Find all")
  @Get()
  findAll(): Promise<LeaderList[]> {
    return this.listsService.findAll();
  }
}
