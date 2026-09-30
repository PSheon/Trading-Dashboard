import { Injectable, NotFoundException } from "@nestjs/common";
import type { ActionsFeedQuery } from "@trading-dashboard/shared/contracts";
import { ActionsRepository, type ActionsFeedFilter } from "./actions.repository.js";
export type { ActionsFeedFilter } from "./actions.repository.js";

@Injectable()
export class ActionsService {
  constructor(private readonly repository: ActionsRepository) {}

  findFeed(query: ActionsFeedQuery, favoritesOf?: number) {
    return this.repository.findFeed(query, favoritesOf);
  }

  findByIds(ids: readonly bigint[]) {
    return this.repository.findByIds(ids);
  }

  findAfter(filter: ActionsFeedFilter, afterId: bigint, since: Date, limit: number, favoritesOf?: number) {
    return this.repository.findAfter(filter, afterId, since, limit, favoritesOf);
  }

  favoriteAddresses(userId: number) {
    return this.repository.favoriteAddresses(userId);
  }

  async getFillsForAction(actionId: bigint) {
    const fills = await this.repository.getFillsForAction(actionId);
    if (fills === undefined) throw new NotFoundException(`No action ${actionId}`);
    return fills;
  }
}
