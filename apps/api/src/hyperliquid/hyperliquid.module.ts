import { Module } from "@nestjs/common";

import { HyperliquidInfoClient } from "./hyperliquid-info.client.js";
import { RequestBudgeterService } from "./request-budgeter.service.js";

@Module({
  providers: [HyperliquidInfoClient, RequestBudgeterService],
  exports: [HyperliquidInfoClient, RequestBudgeterService],
})
export class HyperliquidModule {}
