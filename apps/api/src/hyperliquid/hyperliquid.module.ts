import { Module } from "@nestjs/common";

import { HyperliquidInfoClient } from "./hyperliquid-info.client.js";
import { MarketCatalogService } from "./market-catalog.service.js";
import { RequestBudgeterService } from "./request-budgeter.service.js";
import { UnitOfWork } from '../db/unit-of-work.js';
import { PostgresHyperliquidQuota } from './postgres-hyperliquid-quota.js';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config.js';
import { HyperliquidGlobalTransport } from './hyperliquid-global-transport.js';
import { BackgroundJobs } from '../runtime/background-jobs.service.js';
import { WALLET_NETWORK_HL, walletNetworkHyperliquid } from './wallet-network-hyperliquid.js';

@Module({
  providers: [HyperliquidInfoClient, RequestBudgeterService, MarketCatalogService,
    { provide: PostgresHyperliquidQuota, inject: [UnitOfWork, AppConfig], useFactory: (uow: UnitOfWork, config: AppConfig) =>
      new PostgresHyperliquidQuota(uow, undefined, undefined, config.value.hyperliquid.backgroundRestCap) },
    { provide: HyperliquidGlobalTransport, inject: [PostgresHyperliquidQuota, AppConfig], useFactory: (quota: PostgresHyperliquidQuota, config: AppConfig) =>
      new HyperliquidGlobalTransport(quota, { egressKey: config.value.hyperliquid.egressKey, ownerId: randomUUID() }) },
    // One wallet-network (testnet) bucket per process, shared by every caller.
    { provide: WALLET_NETWORK_HL, inject: [AppConfig, RequestBudgeterService, HyperliquidGlobalTransport, PostgresHyperliquidQuota, HyperliquidInfoClient, { token: BackgroundJobs, optional: true }],
      useFactory: walletNetworkHyperliquid }],
  exports: [HyperliquidInfoClient, RequestBudgeterService, MarketCatalogService, PostgresHyperliquidQuota, HyperliquidGlobalTransport, WALLET_NETWORK_HL],
})
export class HyperliquidModule {}
