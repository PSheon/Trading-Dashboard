import { Controller, Get, Header, Param } from "@nestjs/common";
import { LeaderParamsDto } from "../common/dto/params.dto.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { AdminTraderRepository } from "./admin-trader.repository.js";
@Controller("admin/traders")
@RequirePermissions("traders.read")
export class AdminTraderController {
  constructor(private readonly repository: AdminTraderRepository) {}
  @Get(":chain/:address")
  @Header("Cache-Control", "no-store")
  @ApiDoc(
    "Inspect persisted trader sources and coverage without triggering work",
  )
  detail(@Param() params: LeaderParamsDto) {
    return this.repository.detail(params.address);
  }
}
