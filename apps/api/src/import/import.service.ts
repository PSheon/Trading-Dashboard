import { Injectable } from "@nestjs/common";
import type {
  ImportLeaderListRequest,
  ImportLeaderListResponse,
} from "@trading-dashboard/shared";

/**
 * A1/A2/A5: import a CopyDog list version, dedupe against `leaders`, start
 * watching new addresses, and backfill their available fill history.
 */
@Injectable()
export class ImportService {
  async importLeaderList(
    _request: ImportLeaderListRequest,
  ): Promise<ImportLeaderListResponse> {
    throw new Error("not implemented");
  }
}
