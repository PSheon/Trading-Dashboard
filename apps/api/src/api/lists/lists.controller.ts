import { Controller, Get, Query } from "@nestjs/common";
import type { LeaderList, ListDiffResponse } from "@trading-dashboard/shared/contracts";

import { listDiffRequestSchema } from "@trading-dashboard/shared/contracts";
import { parseOr400 } from "../../common/http/validation.js";
import { RequirePermissions } from "../../common/auth/permissions.js";
import { ListsService } from "./lists.service.js";

@RequirePermissions("lists.read")
@Controller("lists")
export class ListsController {
  constructor(private readonly listsService: ListsService) {}

  @Get()
  findAll(): Promise<LeaderList[]> {
    return this.listsService.findAll();
  }

  @Get("diff")
  diff(@Query() query: Record<string, unknown>): Promise<ListDiffResponse> {
    return this.listsService.diff(parseOr400(listDiffRequestSchema, query));
  }
}
