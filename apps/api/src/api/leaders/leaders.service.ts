import { Injectable } from "@nestjs/common";
import type { Leader, LeadersQuery } from "@trading-dashboard/shared";

/** D2 Leaders table + A3 manual leader management. */
@Injectable()
export class LeadersService {
  async findAll(_query: LeadersQuery): Promise<Leader[]> {
    return [];
  }
}
