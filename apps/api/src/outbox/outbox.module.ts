import { OutboxRepository } from "./outbox.repository.js";
import { Module } from "@nestjs/common";
import { RulesModule } from "../rules/rules.module.js";
import { NotifyModule } from "../notify/notify.module.js";
import { OutboxService } from "./outbox.service.js";
import { OutboxController } from "./outbox.controller.js";
@Module({ imports: [RulesModule, NotifyModule], providers: [OutboxRepository, OutboxService], controllers: [OutboxController] })
export class OutboxModule {}
