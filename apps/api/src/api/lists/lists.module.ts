import { Module } from "@nestjs/common";

import { ListsController } from "./lists.controller.js";
import { ListsService } from "./lists.service.js";

@Module({
  controllers: [ListsController],
  providers: [ListsService],
})
export class ListsModule {}
