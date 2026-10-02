import { Module } from "@nestjs/common";

import { HyperliquidInfoClient } from "./hyperliquid-info.client.js";
import { MarketCatalogService } from "./market-catalog.service.js";
import { RequestBudgeterService } from "./request-budgeter.service.js";

@Module({
  providers: [HyperliquidInfoClient, RequestBudgeterService, MarketCatalogService],
  exports: [HyperliquidInfoClient, RequestBudgeterService, MarketCatalogService],
})
export class HyperliquidModule {}
