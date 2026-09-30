import { Controller, Get, Header } from "@nestjs/common";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { AdminSystemService } from "./admin-system.service.js";

@Controller("admin/system")
@RequirePermissions("admin.access")
export class AdminSystemController {
  constructor(private readonly system: AdminSystemService) {}
  @ApiDoc("System monitoring overview")
  @Header("Cache-Control", "no-store")
  @Get("overview")
  overview() { return this.system.overview(); }
}
