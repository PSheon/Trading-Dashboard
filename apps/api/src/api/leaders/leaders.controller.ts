import { Controller, Get, Query } from "@nestjs/common";
import type { Leader, LeadersQuery } from "@trading-dashboard/shared";

import { LeadersService } from "./leaders.service.js";

@Controller("leaders")
export class LeadersController {
  constructor(private readonly leadersService: LeadersService) {}

  @Get()
  findAll(@Query() query: LeadersQuery): Promise<Leader[]> {
    return this.leadersService.findAll(query);
  }
}
