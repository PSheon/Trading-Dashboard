import { Controller, Get, Query } from "@nestjs/common";
import type {
  LeaderList,
  ListDiffRequest,
  ListDiffResponse,
} from "@trading-dashboard/shared";

import { ListsService } from "./lists.service.js";

@Controller("lists")
export class ListsController {
  constructor(private readonly listsService: ListsService) {}

  @Get()
  findAll(): Promise<LeaderList[]> {
    return this.listsService.findAll();
  }

  @Get("diff")
  diff(@Query() query: ListDiffRequest): Promise<ListDiffResponse> {
    return this.listsService.diff(query);
  }
}
