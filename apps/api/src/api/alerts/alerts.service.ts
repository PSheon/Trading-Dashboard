import { Injectable } from "@nestjs/common";
import type { AlertsQuery } from "@trading-dashboard/shared/contracts";
import type { AlertsScope } from "../../common/auth/alerts-scope.js";
import { AlertsRepository } from "./alerts.repository.js";
@Injectable()
export class AlertsService {
  constructor(private readonly repository: AlertsRepository) {}
  findAll(query: AlertsQuery, scope: AlertsScope) { return this.repository.findVisible(query, scope); }
}
