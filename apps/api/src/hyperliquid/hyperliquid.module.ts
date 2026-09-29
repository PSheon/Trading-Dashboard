import { Module } from "@nestjs/common";

import { HyperliquidInfoClient } from "./hyperliquid-info.client.js";
import { HyperliquidWsClient } from "./hyperliquid-ws.client.js";

@Module({
  providers: [HyperliquidInfoClient, HyperliquidWsClient],
  exports: [HyperliquidInfoClient, HyperliquidWsClient],
})
export class HyperliquidModule {}
