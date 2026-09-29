import { Controller, Get, Query } from "@nestjs/common";
import type {
  LeaderList,
  ListDiffResponse,
} from "@trading-dashboard/shared";

import { listDiffRequestSchema } from "@trading-dashboard/shared";
import { parseOr400 } from "../../users/validation.js";
import { Roles } from "../../common/auth/current-user.js";
import { ListsService } from "./lists.service.js";

@Roles("admin")
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
