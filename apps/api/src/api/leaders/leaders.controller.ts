import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import type { Leader, LeadersQuery, PatchLeaderRequest } from "@trading-dashboard/shared";

import { LeadersService } from "./leaders.service.js";

@Controller("leaders")
export class LeadersController {
  constructor(private readonly leadersService: LeadersService) {}

  @Get()
  findAll(@Query() query: LeadersQuery): Promise<Leader[]> {
    return this.leadersService.findAll(query);
  }

  /** A3: label/tier/notes/active. */
  @Patch(":chain/:address")
  update(
    @Param("chain") chain: string,
    @Param("address") address: string,
    @Body() body: PatchLeaderRequest,
  ): Promise<Leader> {
    return this.leadersService.update(chain, address, body);
  }
}
