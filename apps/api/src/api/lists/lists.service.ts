import { Injectable } from "@nestjs/common";
import type { LeaderList } from "@trading-dashboard/shared/contracts";

/** D6 Lists — version history. Import itself lives in ImportModule. */
@Injectable()
export class ListsService {
  async findAll(): Promise<LeaderList[]> {
    return [];
  }
}
