import { ApiDoc } from "../common/decorators/http.decorator.js";
import { ImportListDto } from "./dto/import-list.dto.js";
import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { Body, Controller, Post, Header, HttpCode } from "@nestjs/common";
import type { ImportLeaderListResponse } from "@trading-dashboard/shared/contracts";

import { RequirePermissions } from "../common/auth/permissions.js";
import { ImportService } from "./import.service.js";

@RequirePermissions("leaders.import")
@Controller("import")
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post("lists/preview")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiDoc("Preview list import effects without persisting or enqueuing work")
  preview(@Body() body: ImportListDto) {
    return this.importService.previewLeaderList(body);
  }

  /** A1: upload a CopyDog CSV/JSON export (parsed to rows client-side). */
  @ApiDoc("Import list")
  @Post("lists")
  importList(
    @Body() body: ImportListDto,
    @CurrentUser() actor: RequestUser | null,
  ): Promise<ImportLeaderListResponse> {
    return this.importService.importLeaderList(body, actor);
  }
}
