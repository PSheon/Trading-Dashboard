import { Module } from "@nestjs/common";

import { HyperliquidInfoClient } from "./hyperliquid-info.client.js";
import { MarketCatalogService } from "./market-catalog.service.js";
import { RequestBudgeterService } from "./request-budgeter.service.js";
import { UnitOfWork } from '../db/unit-of-work.js';
import { PostgresHyperliquidQuota } from './postgres-hyperliquid-quota.js';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config.js';
import { HyperliquidGlobalTransport } from './hyperliquid-global-transport.js';

@Module({
  providers: [HyperliquidInfoClient, RequestBudgeterService, MarketCatalogService,
    { provide: PostgresHyperliquidQuota, inject: [UnitOfWork], useFactory: (uow: UnitOfWork) => new PostgresHyperliquidQuota(uow) },
    { provide: HyperliquidGlobalTransport, inject: [PostgresHyperliquidQuota, AppConfig], useFactory: (quota: PostgresHyperliquidQuota, config: AppConfig) =>
      new HyperliquidGlobalTransport(quota, { egressKey: config.value.hyperliquid.egressKey, ownerId: randomUUID() }) }],
  exports: [HyperliquidInfoClient, RequestBudgeterService, MarketCatalogService, PostgresHyperliquidQuota, HyperliquidGlobalTransport],
})
export class HyperliquidModule {}
