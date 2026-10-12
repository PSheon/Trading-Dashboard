import { Module } from '@nestjs/common';

import { HyperliquidInfoClient } from '../hyperliquid/hyperliquid-info.client.js';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module.js';
import { LeaderActivityService } from './leader-activity.service.js';

/** One instance (and cache) for the trader routes and the copy setup. */
@Module({ imports: [HyperliquidModule], providers: [{ provide: LeaderActivityService, inject: [HyperliquidInfoClient], useFactory: (info: HyperliquidInfoClient) => new LeaderActivityService(info) }],
  exports: [LeaderActivityService] })
export class LeaderActivityModule {}
