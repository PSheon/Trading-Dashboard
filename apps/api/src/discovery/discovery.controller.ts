import { BadGatewayException, Body, Controller, Delete, Get, HttpCode, HttpException, Logger, Param, Patch, Post, Query, UseFilters } from "@nestjs/common";
import type { BoardResponse, CopyScoreResponse, HomeBoardsResponse, Kol, KolImportResponse } from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { Public } from "../common/auth/public.decorator.js";
import { ApiDoc, ResponseMessage } from "../common/decorators/http.decorator.js";
import { AddressParamsDto } from "../common/dto/params.dto.js";
import { BusyException, BusyFilter } from "../traders/busy.js";
import { BUSY_RETRY_AFTER_MS, PAGE_DEADLINE_MS } from "../traders/traders.controller.js";
import { DiscoveryService } from "./discovery.service.js";
import { BoardQueryDto, KolImportDto, KolInputDto, KolPatchDto } from "./dto/discovery.dto.js";
import { KolService } from "./kol.service.js";

/** Explore boards and home rows (Stage 3). Public; served from the
 * discovery pool table, no Hyperliquid calls. */
@Public()
@Controller("discover")
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @ApiDoc("Board", "One explore board: fixed top 100, crypto or stocks, top100 / kol / a coin.")
  @Get("boards")
  board(@Query() query: BoardQueryDto): Promise<BoardResponse> {
    return this.discovery.board({ market: query.market, board: query.board, sort: query.sort, window: query.window, style: query.style });
  }

  @ApiDoc("Home rows", "Every home-page row and the calculator's traders in one read.")
  @Get("home")
  home(): Promise<HomeBoardsResponse> {
    return this.discovery.home();
  }
}

/** GET /traders/:address/copy-score: the trader page's 複製評分. */
@Public()
@Controller("traders")
@UseFilters(BusyFilter)
export class CopyScoreController {
  private readonly logger = new Logger(CopyScoreController.name);
  /** Settable for tests. */
  deadlineMs = PAGE_DEADLINE_MS;

  constructor(private readonly discovery: DiscoveryService) {}

  @ApiDoc("Copy score")
  @Get(":address/copy-score")
  async copyScore(@Param() params: AddressParamsDto): Promise<CopyScoreResponse> {
    const work = this.discovery.copyScore(params.address);
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BusyException(BUSY_RETRY_AFTER_MS)), this.deadlineMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Copy score ${params.address}: ${(error as Error).message}`);
      throw new BadGatewayException("Upstream request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The KOL registry (admin): list, add / edit, remove, CSV import. */
@RequirePermissions("admin.access", "kols.manage")
@Controller("admin/kols")
export class AdminKolController {
  constructor(private readonly kols: KolService) {}

  @ApiDoc("List KOLs")
  @Get()
  list(): Promise<Kol[]> {
    return this.kols.list();
  }

  @ResponseMessage("KOL saved")
  @ApiDoc("Add or replace a KOL")
  @Post()
  upsert(@Body() body: KolInputDto, @CurrentUser() user: RequestUser | null): Promise<Kol> {
    return this.kols.upsert({ ...body }, user);
  }

  @ResponseMessage("KOLs imported")
  @ApiDoc("Import KOLs from CSV")
  @Post("import")
  import(@Body() body: KolImportDto, @CurrentUser() user: RequestUser | null): Promise<KolImportResponse> {
    return this.kols.importCsv(body.csv, body.replace ?? false, user);
  }

  @ResponseMessage("KOL updated")
  @ApiDoc("Edit a KOL")
  @Patch(":address")
  patch(@Param() params: AddressParamsDto, @Body() body: KolPatchDto, @CurrentUser() user: RequestUser | null): Promise<Kol> {
    return this.kols.patch(params.address, { ...body }, user);
  }

  @ApiDoc("Remove a KOL")
  @Delete(":address")
  @HttpCode(204)
  async remove(@Param() params: AddressParamsDto, @CurrentUser() user: RequestUser | null): Promise<void> {
    await this.kols.remove(params.address, user);
  }
}
