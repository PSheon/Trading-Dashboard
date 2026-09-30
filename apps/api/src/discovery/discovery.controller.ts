import { BadGatewayException, Body, Controller, Delete, Get, HttpCode, HttpException, Logger, NotFoundException, Param, Patch, Post, Query, Req, Res, StreamableFile, UseFilters } from "@nestjs/common";
import type { Request, Response } from "express";
import type {
  BoardResponse,
  CoinBoardResponse,
  CoinIndexResponse,
  CopyScoreResponse,
  HomeBoardsResponse,
  Kol,
  KolImportResponse,
  TraderCardsResponse,
  TraderSearchResponse,
} from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { Public } from "../common/auth/public.decorator.js";
import { ApiDoc, ResponseMessage, SkipTransform } from "../common/decorators/http.decorator.js";
import { AddressParamsDto } from "../common/dto/params.dto.js";
import { BusyException, BusyFilter } from "../traders/busy.js";
import { BUSY_RETRY_AFTER_MS, PAGE_DEADLINE_MS, isBusyError } from "../traders/traders.controller.js";
import { DiscoveryService } from "./discovery.service.js";
import { AvatarQueryDto, BoardQueryDto, CoinParamsDto, KolImportDto, KolInputDto, KolPatchDto, TraderCardsQueryDto, TraderSearchQueryDto } from "./dto/discovery.dto.js";
import { AVATAR_MAX_AGE_S, avatarVersion } from "./kol-avatar.js";
import { KolAvatarService } from "./kol-avatar.service.js";
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

  @ApiDoc("Coin index", "CopyDog's 市場 page: every coin a pool trader made money on, with the count and summed PnL of those traders.")
  @Get("coins")
  coins(): Promise<CoinIndexResponse> {
    return this.discovery.coins();
  }

  @ApiDoc("Coin leaderboard", "The pool's traders who made money on one coin, by its realized PnL (at most 40), with win rate, trades, volume and totals.")
  @Get("coins/:coin")
  coin(@Param() params: CoinParamsDto): Promise<CoinBoardResponse> {
    return this.discovery.coin(params.coin);
  }

  @ApiDoc("Trader search", "Header search: KOL name, X handle, leaderboard name or address prefix; by all-time PnL.")
  @Get("search")
  search(@Query() query: TraderSearchQueryDto): Promise<TraderSearchResponse> {
    return this.discovery.search({ q: query.q, limit: query.limit });
  }

  @ApiDoc("Trader cards", "Watchlist cards (explore card plus 30-day PnL, win rate, Sharpe, max drawdown) for up to 200 addresses.")
  @Get("cards")
  cards(@Query() query: TraderCardsQueryDto): Promise<TraderCardsResponse> {
    return this.discovery.cards(query.addresses.split(","));
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
      // The page budget refused or dropped the work: not now, not failed.
      if (isBusyError(error)) throw new BusyException(BUSY_RETRY_AFTER_MS);
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

/** GET /kols/:address/avatar: a KOL's picture from the api's own cache
 * (`kol_avatars`), so pages never hotlink a third-party host. 404 until the
 * drip job has fetched it; the web then draws its generated avatar. */
@Public()
@Controller("kols")
export class KolAvatarController {
  constructor(private readonly avatars: KolAvatarService) {}

  @ApiDoc("KOL avatar", "The cached image bytes (PNG, JPEG, GIF or WebP). A URL whose `v` matches the current version is cached for a month; If-None-Match answers 304.")
  @SkipTransform()
  @Get(":address/avatar")
  async avatar(
    @Param() params: AddressParamsDto,
    @Query() query: AvatarQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    const image = await this.avatars.find(params.address);
    if (!image) throw new NotFoundException("No cached avatar");
    const current = query.v === avatarVersion(image.etag);
    res.setHeader("ETag", image.etag);
    res.setHeader("Cache-Control", current ? `public, max-age=${AVATAR_MAX_AGE_S}, immutable` : "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    const match = req.header("if-none-match");
    if (match && match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === image.etag)) {
      res.status(304);
      return undefined;
    }
    return new StreamableFile(image.bytes, { type: image.contentType, length: image.bytes.length });
  }
}
