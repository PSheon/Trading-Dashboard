import { Body, Controller, Post } from "@nestjs/common";
import type {
  ImportLeaderListRequest,
  ImportLeaderListResponse,
} from "@trading-dashboard/shared";

import { Roles } from "../common/auth/current-user.js";
import { ImportService } from "./import.service.js";

@Roles("admin")
@Controller("import")
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  /** A1: upload a CopyDog CSV/JSON export (parsed to rows client-side). */
  @Post("lists")
  importList(
    @Body() body: ImportLeaderListRequest,
  ): Promise<ImportLeaderListResponse> {
    return this.importService.importLeaderList(body);
  }
}
