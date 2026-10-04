import { TraderSearchController } from "./trader-search.controller.js";
import { TraderSearchRepository } from "./trader-search.repository.js";
import { Module } from "@nestjs/common";
import { AppConfig } from '../config/app-config.js';
import { HyperliquidAllDexsAccountSource } from '../copy/live/live-account-ws-source.js';
import { TraderOrdersReader } from './trader-orders-reader.js';
import { TraderTwapReader } from './trader-twap-reader.js';
import { TraderAccountReader } from './trader-account-reader.js';
import { HyperliquidGlobalTransport } from '../hyperliquid/hyperliquid-global-transport.js';

import { TradersRepository } from "./traders.repository.js";
import { LeaderboardIngestRepository } from "./leaderboard-ingest.repository.js";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { KolAvatarModule } from "../discovery/kol-avatar.module.js";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { TradersController } from "./traders.controller.js";
import { ChartSnapshotsService } from "./chart-snapshots.service.js";
import { SpotPriceService } from "./spot-price.service.js";
import { TradersService } from "./traders.service.js";
import { TradeAnalyticsController } from "./trade-analytics.controller.js";
import { TradeAnalyticsRepository } from "./trade-analytics.repository.js";
import { TradeAnalyticsService } from "./trade-analytics.service.js";

import { AnalysisHistoryRepository } from "./analysis-history.repository.js";
import { AnalysisHistoryService } from "./analysis-history.service.js";

/** Discovery capabilities and HTTP routes; startup/cron belongs to TradersWorkerModule. */
@Module({
  imports: [HyperliquidModule, AnalyticsModule, KolAvatarModule],
  controllers: [TraderSearchController, TradersController, TradeAnalyticsController],
  providers: [ChartSnapshotsService, TraderSearchRepository, AnalysisHistoryRepository, AnalysisHistoryService, LeaderboardIngestRepository, TradersRepository, TradersService, LeaderboardIngestService, SpotPriceService, TradeAnalyticsRepository, TradeAnalyticsService,
    { provide: TraderOrdersReader, inject: [AppConfig, HyperliquidGlobalTransport], useFactory: (config: AppConfig, transport: HyperliquidGlobalTransport) => new TraderOrdersReader(
      new HyperliquidAllDexsAccountSource(Date.now, undefined, config.value.hyperliquid.apiUrl === 'https://api.hyperliquid-testnet.xyz/info' ? 'testnet' : 'mainnet', transport), Date.now, config.value.hyperliquid.apiUrl) },
    { provide: TraderTwapReader, inject: [AppConfig, HyperliquidGlobalTransport], useFactory: (config: AppConfig, transport: HyperliquidGlobalTransport) =>
      new TraderTwapReader(transport, config.value.hyperliquid.apiUrl === 'https://api.hyperliquid-testnet.xyz/info' ? 'testnet' : 'mainnet', { infoUrl: config.value.hyperliquid.apiUrl }) },
    { provide: TraderAccountReader, inject: [AppConfig, HyperliquidGlobalTransport], useFactory: (config: AppConfig, transport: HyperliquidGlobalTransport) =>
      new TraderAccountReader(new HyperliquidAllDexsAccountSource(Date.now, undefined, config.value.hyperliquid.apiUrl === 'https://api.hyperliquid-testnet.xyz/info' ? 'testnet' : 'mainnet', transport),
        Date.now, config.value.hyperliquid.apiUrl) }],
  exports: [AnalysisHistoryService, TradersService, LeaderboardIngestService, TradeAnalyticsService],
})
export class TradersModule {}
