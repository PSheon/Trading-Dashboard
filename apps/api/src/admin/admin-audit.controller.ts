import { Controller, Get, Header, Query } from "@nestjs/common";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { AdminAuditRepository } from "./admin-audit.repository.js";
import { AuditQueryDto } from "./dto/audit.dto.js";
@Controller("admin/audit")
@RequirePermissions("audit.read")
export class AdminAuditController {
  constructor(private readonly repository: AdminAuditRepository) {}
  @Get()
  @ApiDoc("List recorded administrative changes")
  @Header("Cache-Control", "no-store")
  list(@Query() query: AuditQueryDto) { return this.repository.list(query); }
}
