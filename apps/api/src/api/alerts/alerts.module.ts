import { AlertsRepository } from "./alerts.repository.js";
import { Module } from "@nestjs/common";

import { AlertsController } from "./alerts.controller.js";
import { AlertsService } from "./alerts.service.js";

@Module({
  controllers: [AlertsController],
  providers: [AlertsRepository, AlertsService],
})
export class AlertsModule {}
