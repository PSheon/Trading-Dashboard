import { Module } from "@nestjs/common";

import { IngestionModule } from "../watcher/ingestion.module.js";
import { ImportController } from "./import.controller.js";
import { ImportService } from "./import.service.js";

@Module({
  imports: [IngestionModule],
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
