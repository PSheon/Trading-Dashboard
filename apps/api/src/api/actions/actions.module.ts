import { Module } from "@nestjs/common";

import { ActionsController } from "./actions.controller.js";
import { ActionsService } from "./actions.service.js";

@Module({
  controllers: [ActionsController],
  providers: [ActionsService],
})
export class ActionsModule {}
