import { Module } from "@nestjs/common";

import { HyperliquidInfoClient } from "./hyperliquid-info.client.js";
import { HyperliquidWsClient } from "./hyperliquid-ws.client.js";
import { RequestBudgeterService } from "./request-budgeter.service.js";

@Module({
  providers: [HyperliquidInfoClient, HyperliquidWsClient, RequestBudgeterService],
  exports: [HyperliquidInfoClient, HyperliquidWsClient, RequestBudgeterService],
})
export class HyperliquidModule {}
