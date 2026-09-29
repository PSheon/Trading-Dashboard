import { Body, Controller, Post } from "@nestjs/common";
import type {
  ImportLeaderListResponse,
} from "@trading-dashboard/shared";

import { importLeaderListRequestSchema } from "@trading-dashboard/shared";
import { parseOr400 } from "../users/validation.js";
import { Roles } from "../common/auth/current-user.js";
import { ImportService } from "./import.service.js";

@Roles("admin")
@Controller("import")
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  /** A1: upload a CopyDog CSV/JSON export (parsed to rows client-side). */
  @Post("lists")
  importList(
    @Body() body: unknown,
  ): Promise<ImportLeaderListResponse> {
    return this.importService.importLeaderList(parseOr400(importLeaderListRequestSchema, body));
  }
}
