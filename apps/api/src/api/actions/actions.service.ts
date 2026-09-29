import { Injectable } from "@nestjs/common";
import type { Action, ActionsFeedQuery } from "@trading-dashboard/shared";

/** D1 Live Feed — reads the aggregated `actions` table only (§3 principle 3). */
@Injectable()
export class ActionsService {
  async findFeed(_query: ActionsFeedQuery): Promise<Action[]> {
    return [];
  }
}
