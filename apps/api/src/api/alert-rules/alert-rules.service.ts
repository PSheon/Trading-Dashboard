import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { AlertRule, UpsertAlertRuleRequest } from "@trading-dashboard/shared/contracts";

import type { AuditActor } from "../../common/audit/admin-audit.js";
import { UnitOfWork } from "../../db/unit-of-work.js";
import { AlertRulesRepository } from "./alert-rules.repository.js";

/** D5 rule editor for the DEFAULT rules (`user_id IS NULL`), which
 * RulesService evaluates for admins on imported leaders. Rows with an
 * owner are no longer created (migration 0006 removed the old per-user
 * copies) and are never listed or edited here. */
@Injectable()
export class AlertRulesService {
  constructor(private readonly repository: AlertRulesRepository, private readonly unitOfWork: UnitOfWork) {}

  async findAll(): Promise<AlertRule[]> {
    return await this.repository.findAll() as unknown as AlertRule[];
  }

  /** Default normalization, conflict/not-found policy and audit share one use-case transaction. */
  async upsert(request: UpsertAlertRuleRequest, actor: AuditActor = null): Promise<AlertRule> {
    const values = {
      scope: request.scope, kind: request.kind, paramsJson: request.paramsJson,
      cooldownS: request.cooldownS, quietHours: request.quietHours ?? null,
      tiers: request.tiers, enabled: request.enabled ?? true,
    };
    return this.unitOfWork.run(async (tx) => {
      if (request.id !== undefined) {
        const before = await this.repository.lockDefault(tx, request.id);
        if (!before) throw new NotFoundException(`No default alert rule ${request.id}`);
        const updated = await this.repository.update(tx, request.id, values);
        if (!updated) throw new NotFoundException(`No default alert rule ${request.id}`);
        await this.repository.recordAudit(tx, actor, "rule.update", before, updated);
        return updated as unknown as AlertRule;
      }
      const inserted = await this.repository.insert(tx, values);
      if (!inserted) throw new ConflictException(`A default ${request.kind} rule already exists; update it by id`);
      await this.repository.recordAudit(tx, actor, "rule.create", null, inserted);
      return inserted as unknown as AlertRule;
    });
  }
}
