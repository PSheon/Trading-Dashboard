import { Injectable, Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { TradersModule } from "../traders/traders.module.js";
import { AdminKolController, CopyScoreController, DiscoveryController, KolAvatarController } from "./discovery.controller.js";
import { DiscoveryPoolService } from "./discovery-pool.service.js";
import { DiscoveryRepository } from "./discovery.repository.js";
import { DiscoveryService } from "./discovery.service.js";
import { KolAvatarModule } from "./kol-avatar.module.js";
import { KolAvatarService } from "./kol-avatar.service.js";
import { KolRepository } from "./kol.repository.js";
import { KolService } from "./kol.service.js";

/** Stage 3 discovery: boards, home rows, copy score, the KOL registry and
 * the pool refresh capability. The cron binding lives in
 * DiscoveryWorkerModule, so importing this starts no background work. */
@Module({
  imports: [HyperliquidModule, TradersModule, KolAvatarModule],
  controllers: [DiscoveryController, CopyScoreController, AdminKolController, KolAvatarController],
  providers: [DiscoveryRepository, DiscoveryService, DiscoveryPoolService, KolRepository, KolService],
  exports: [DiscoveryPoolService, KolService, KolAvatarModule],
})
export class DiscoveryModule {}

@Injectable()
class DiscoveryWorker {
  constructor(private readonly pool: DiscoveryPoolService, private readonly avatars: KolAvatarService) {}
  @Cron(CronExpression.EVERY_MINUTE) poolTick() { return this.pool.onTick(); }
  /** One KOL avatar fetch at most every 30 s (no Hyperliquid weight). */
  @Cron(CronExpression.EVERY_30_SECONDS) avatarTick() { return this.avatars.onTick(); }
}

/** The pool refresh and avatar drip schedules (none in tests). */
@Module({ imports: [DiscoveryModule], providers: [DiscoveryWorker] })
export class DiscoveryWorkerModule {}
