import { Module } from "@nestjs/common";

import { ActionStreamService } from "./action-stream.service.js";
import { ActionsController } from "./actions.controller.js";
import { ActionsService } from "./actions.service.js";

@Module({
  controllers: [ActionsController],
  providers: [ActionsService, ActionStreamService],
})
export class ActionsModule {}
