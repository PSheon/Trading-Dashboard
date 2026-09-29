import { Injectable } from "@nestjs/common";
import type {
  LeaderList,
  ListDiffRequest,
  ListDiffResponse,
} from "@trading-dashboard/shared";

/** D6 Lists — version history + diff (A4). Import itself lives in ImportModule. */
@Injectable()
export class ListsService {
  async findAll(): Promise<LeaderList[]> {
    return [];
  }

  async diff(_request: ListDiffRequest): Promise<ListDiffResponse> {
    return { entries: [] };
  }
}
