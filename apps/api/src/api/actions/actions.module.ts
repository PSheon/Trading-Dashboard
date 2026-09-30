import { ActionsRepository } from "./actions.repository.js";
import { AuthModule } from "../../common/auth/auth.module.js";
import { Module } from "@nestjs/common";

import { ActionStreamService } from "./action-stream.service.js";
import { ActionsController } from "./actions.controller.js";
import { ActionsService } from "./actions.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ActionsController],
  providers: [ActionsRepository, ActionsService, ActionStreamService],
})
export class ActionsModule {}
