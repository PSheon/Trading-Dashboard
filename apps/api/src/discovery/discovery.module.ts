import { Injectable, Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { TradersModule } from "../traders/traders.module.js";
import { AdminKolController, CopyScoreController, DiscoveryController } from "./discovery.controller.js";
import { DiscoveryPoolService } from "./discovery-pool.service.js";
import { DiscoveryRepository } from "./discovery.repository.js";
import { DiscoveryService } from "./discovery.service.js";
import { KolRepository } from "./kol.repository.js";
import { KolService } from "./kol.service.js";

/** Stage 3 discovery: boards, home rows, copy score, the KOL registry and
 * the pool refresh capability. The cron binding lives in
 * DiscoveryWorkerModule, so importing this starts no background work. */
@Module({
  imports: [HyperliquidModule, TradersModule],
  controllers: [DiscoveryController, CopyScoreController, AdminKolController],
  providers: [DiscoveryRepository, DiscoveryService, DiscoveryPoolService, KolRepository, KolService],
  exports: [DiscoveryPoolService, KolService],
})
export class DiscoveryModule {}

@Injectable()
class DiscoveryWorker {
  constructor(private readonly pool: DiscoveryPoolService) {}
  @Cron(CronExpression.EVERY_MINUTE) poolTick() { return this.pool.onTick(); }
}

/** The pool refresh schedule (one tick a minute; none in tests). */
@Module({ imports: [DiscoveryModule], providers: [DiscoveryWorker] })
export class DiscoveryWorkerModule {}
