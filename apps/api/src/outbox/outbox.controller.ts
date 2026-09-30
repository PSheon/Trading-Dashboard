import { ApiDoc } from "../common/decorators/http.decorator.js";
import { Controller, Get, Inject } from "@nestjs/common";
import { actionOutbox, notificationOutbox } from "@trading-dashboard/shared/database";
import { count } from "drizzle-orm";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { RequirePermissions } from "../common/auth/permissions.js";

@Controller("admin/outbox")
@RequirePermissions("admin.access")
export class OutboxController {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  @ApiDoc("Status")
  @Get()
  async status() {
    const [evaluations, deliveries] = await Promise.all([
      this.db.select({ status: actionOutbox.status, count: count() }).from(actionOutbox).groupBy(actionOutbox.status),
      this.db.select({ status: notificationOutbox.status, count: count() }).from(notificationOutbox).groupBy(notificationOutbox.status),
    ]);
    return { evaluations, deliveries };
  }
}
