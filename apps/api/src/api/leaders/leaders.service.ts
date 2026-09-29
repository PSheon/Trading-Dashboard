import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  leaders,
  type Leader,
  type LeadersQuery,
  type PatchLeaderRequest,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

/** D2 Leaders table + A3 manual leader management. */
@Injectable()
export class LeadersService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async findAll(query: LeadersQuery): Promise<Leader[]> {
    const conditions = [];
    if (query.tier) conditions.push(eq(leaders.tier, query.tier));
    if (query.active !== undefined) conditions.push(eq(leaders.active, query.active));

    const rows = await this.db
      .select()
      .from(leaders)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    // `chain` is `text` at the drizzle-inferred type level but is always
    // 'hyperliquid' in practice (v1 never writes anything else) — the zod
    // `Leader` contract narrows it to that literal for every consumer.
    return rows as unknown as Leader[];
  }

  /** A3: update label/tier/notes/active. `active=false` alone is what
   * stops polling/snapshots — the Watcher re-reads `leaders` fresh every
   * cycle and filters on `active=true` there, so there's nothing else to
   * wire up here for that half of the acceptance criterion. */
  async update(chain: string, address: string, patch: PatchLeaderRequest): Promise<Leader> {
    const [updated] = await this.db
      .update(leaders)
      .set(patch)
      .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
      .returning();

    if (!updated) {
      throw new NotFoundException(`No leader ${chain}/${address}`);
    }
    return updated as unknown as Leader;
  }
}
