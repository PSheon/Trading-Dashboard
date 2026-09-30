import { Controller, Get, Header } from "@nestjs/common";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { AdminSourcesRepository } from "./admin-sources.repository.js";
@Controller("admin/data-sources")
@RequirePermissions("sources.read")
export class AdminSourcesController {
  constructor(private readonly repository: AdminSourcesRepository) {}
  @Get()
  @Header("Cache-Control", "no-store")
  @ApiDoc("Read distinct source-set evidence; counts may overlap")
  list() {
    return this.repository.list();
  }
}
