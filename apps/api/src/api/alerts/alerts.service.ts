import { Injectable } from "@nestjs/common";
import type { AlertEntry, AlertsQuery } from "@trading-dashboard/shared";

/** D5 Alerts log (N2). */
@Injectable()
export class AlertsService {
  async findAll(_query: AlertsQuery): Promise<AlertEntry[]> {
    return [];
  }
}
