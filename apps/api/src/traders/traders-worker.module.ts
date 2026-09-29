import { Injectable, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { TradersService } from "./traders.service.js";
import { TradersModule } from "./traders.module.js";
@Injectable()
class TradersWorker implements OnApplicationBootstrap {
  constructor(private readonly ingest: LeaderboardIngestService, private readonly traders: TradersService) {}
  onApplicationBootstrap() { this.ingest.start(); this.traders.startWarming(); }
  @Cron(CronExpression.EVERY_MINUTE) ingestTick() { return this.ingest.onTick(); }
  @Cron("0 */10 * * * *") warmTick() { return this.traders.onWarmSchedule(); }
}
@Module({ imports: [TradersModule], providers: [TradersWorker] })
export class TradersWorkerModule {}
