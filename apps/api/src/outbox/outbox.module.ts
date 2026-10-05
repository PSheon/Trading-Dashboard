import { OutboxRepository } from "./outbox.repository.js";
import { Module } from "@nestjs/common";
import { RulesModule } from "../rules/rules.module.js";
import { NotifyModule } from "../notify/notify.module.js";
import { OutboxService } from "./outbox.service.js";

/** The outbox drain (worker process only). */
@Module({ imports: [RulesModule, NotifyModule], providers: [OutboxRepository, OutboxService] })
export class OutboxWorkerModule {}
