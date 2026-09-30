import { Module } from "@nestjs/common";

import { KolAvatarRepository } from "./kol-avatar.repository.js";
import { KolAvatarService } from "./kol-avatar.service.js";

/** The KOL avatar cache and the KOL card read, shared by discovery (boards,
 * the avatar route, the drip job) and the trader page (its header). Starts
 * no background work: the drip's cron binding is in DiscoveryWorkerModule. */
@Module({
  providers: [KolAvatarRepository, KolAvatarService],
  exports: [KolAvatarRepository, KolAvatarService],
})
export class KolAvatarModule {}
