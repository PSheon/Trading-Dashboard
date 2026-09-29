import { Injectable } from "@nestjs/common";
import type {
  AlertRule,
  UpsertAlertRuleRequest,
} from "@trading-dashboard/shared";

/** D5 rule editor (§4.3 R1–R9). */
@Injectable()
export class AlertRulesService {
  async findAll(): Promise<AlertRule[]> {
    return [];
  }

  async upsert(_request: UpsertAlertRuleRequest): Promise<AlertRule> {
    throw new Error("not implemented");
  }
}
