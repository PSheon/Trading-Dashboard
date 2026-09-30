import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { ListDiffQueryDto } from "./dto/list-query.dto.js";
import { Controller, Get, Query } from "@nestjs/common";
import type { LeaderList, ListDiffResponse } from "@trading-dashboard/shared/contracts";



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

  @ApiDoc("Diff")
  @Get("diff")
  diff(@Query() query: ListDiffQueryDto): Promise<ListDiffResponse> {
    return this.listsService.diff(query);
  }
}
