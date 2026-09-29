import { Module } from "@nestjs/common";

import { WatcherModule } from "../watcher/watcher.module.js";
import { ImportController } from "./import.controller.js";
import { ImportService } from "./import.service.js";

@Module({
  imports: [WatcherModule],
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
