import { ApiDoc } from "../common/decorators/http.decorator.js";
import { AddressParamsDto } from "../common/dto/params.dto.js";
import { TradersQueryDto, SparklinesQueryDto, PortfolioQueryDto, FillsQueryDto } from "./dto/trader-query.dto.js";

import { BadGatewayException, BadRequestException, Controller, Get, HttpException, Logger, Param, Query, UseFilters } from "@nestjs/common";
import {
  type PortfolioResponse,
  type SparklinesResponse,
  type TraderActivityResponse,
  type TraderFill,
  type TraderOrdersResponse,
  type TraderProfileResponse,
  type TradersResponse,
  type TraderTransfersResponse,
  type TraderTwapsResponse,
} from "@trading-dashboard/shared/contracts";

import { CurrentUser, userIdOf, type RequestUser } from "../common/auth/current-user.js";
import { Public } from "../common/auth/public.decorator.js";
import { BusyException, BusyFilter } from "./busy.js";
import { TradersService } from "./traders.service.js";
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';

export const DEFAULT_FILLS_LIMIT = 50;
/** CopyDog's 成交 tab reads up to 2,000 fills (one `userFills` page). */
export const MAX_FILLS_LIMIT = 2000;
/** A trader-page request answers within this long, well inside the web
 * forwarder's 20 s timeout: past it, 503 busy. */
export const PAGE_DEADLINE_MS = 12_000;
/** Retry-After of a busy answer. The work it was waiting on continues, so
 * a retry this much later usually finds it cached. */
export const BUSY_RETRY_AFTER_MS = 5_000;
/** Addresses per sparkline request without a session (one explore page);
 * a signed-in caller may ask for 30 (`SparklinesQueryDto`). */
export const ANONYMOUS_SPARKLINE_MAX = 25;

/** Errors that mean "not now" rather than "Hyperliquid failed": the page
 * budget is full, or the work was dropped because a request sharing it was
 * answered or abandoned. */
export function isBusyError(error: unknown): boolean {
  const name = (error as Error | undefined)?.name;
  return name === "PageBusyError" || name === "AbortError" || name === "TimeoutError" ||
    error instanceof LiveBoundaryError && ['hyperliquid_quota_exhausted', 'hyperliquid_quota_connections',
      'hyperliquid_quota_subscriptions', 'hyperliquid_quota_users', 'hyperliquid_quota_queue_full', 'hyperliquid_quota_expired'].includes(error.code);
}

/**
 * Discovery (Stage 2 §4). Public: anyone can browse the leaderboard and any
 * trader's page; `favorite` flags are filled in for a signed-in caller.
 * A trader page is several requests so the cheap first paint (`:address`)
 * never waits on the expensive fill lists (`:address/activity`,
 * `:address/fills`). Any of them answers 503 `{code: "busy"}` with
 * Retry-After when it can't be ready in time (`PAGE_DEADLINE_MS`).
 */
@Public()
@Controller("traders")
@UseFilters(BusyFilter)
export class TradersController {
  private readonly logger = new Logger(TradersController.name);
  /** Settable for tests. */
  pageDeadlineMs = PAGE_DEADLINE_MS;

  constructor(private readonly traders: TradersService) {}

  @ApiDoc("List")
  @Get()
  list(@Query() query: TradersQueryDto, @CurrentUser() user: RequestUser | null): Promise<TradersResponse> {
    return this.traders.list(query, userIdOf(user));
  }

  /** Declared before `:address` so "sparklines" isn't taken for an address. */
  @ApiDoc("Sparklines")
  @Get("sparklines")
  sparklines(@Query() query: SparklinesQueryDto, @CurrentUser() user: RequestUser | null = null): Promise<SparklinesResponse> {
    const { addresses, window } = query;
    const unique = [...new Set(addresses)];
    const anonymous = userIdOf(user) === null;
    if (anonymous && unique.length > ANONYMOUS_SPARKLINE_MAX) {
      throw new BadRequestException(`At most ${ANONYMOUS_SPARKLINE_MAX} addresses without signing in`);
    }
    return this.traders.sparklines(unique, window, { fetch: anonymous ? "listed" : "any" });
  }

  @ApiDoc("Profile")
  @Get(":address")
  profile(
    @Param() params: AddressParamsDto,
    @CurrentUser() user: RequestUser | null,
  ): Promise<TraderProfileResponse> {
    const addr = params.address;
    return this.upstream(this.traders.profile(addr, userIdOf(user)), addr);
  }

  @ApiDoc("Portfolio")
  @Get(":address/portfolio")
  portfolio(@Param() params: AddressParamsDto, @Query() query: PortfolioQueryDto): Promise<PortfolioResponse> {
    const addr = params.address;
    return this.upstream(this.traders.portfolio(addr, query), addr);
  }

  @ApiDoc("Fills")
  @Get(":address/fills")
  fills(@Param() params: AddressParamsDto, @Query() query: FillsQueryDto): Promise<TraderFill[]> {
    const addr = params.address;
    return this.upstream(this.traders.fills(addr, query.limit), addr);
  }

  /** Sample size and last trade (fills-derived; loads after the profile). */
  @ApiDoc("Activity")
  @Get(":address/activity")
  activity(@Param() params: AddressParamsDto): Promise<TraderActivityResponse> {
    const addr = params.address;
    return this.upstream(this.traders.activity(addr), addr);
  }

  /** Resting orders across dexes (the 訂單 tab; loaded when it opens). */
  @ApiDoc("Open orders")
  @Get(":address/orders")
  orders(@Param() params: AddressParamsDto): Promise<TraderOrdersResponse> {
    const addr = params.address;
    return this.upstream(this.traders.orders(addr), addr);
  }

  /** Running TWAP orders (the TWAP tab). */
  @ApiDoc("Running TWAP orders")
  @Get(":address/twap")
  twap(@Param() params: AddressParamsDto): Promise<TraderTwapsResponse> {
    const addr = params.address;
    return this.upstream(this.traders.twaps(addr), addr);
  }

  /** Deposits, withdrawals and transfers of the last 90 days (the 轉帳 tab
   * and the live feed). */
  @ApiDoc("Transfers")
  @Get(":address/transfers")
  transfers(@Param() params: AddressParamsDto): Promise<TraderTransfersResponse> {
    const addr = params.address;
    return this.upstream(this.traders.transfers(addr), addr);
  }

  /**
   * A Hyperliquid failure is a 502, not a 500. An answer that isn't ready
   * within `pageDeadlineMs` (the request budget is backed up), or whose
   * work the budget refused (`PageBusyError`), is a 503 busy with
   * Retry-After. Calls already sent carry on into the caches, so the retry
   * starts from them; calls still queued are dropped with the answer.
   */
  private async upstream<T>(promise: Promise<T>, address: string): Promise<T> {
    // It may settle after we have answered; that is not an unhandled error.
    promise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BusyException(BUSY_RETRY_AFTER_MS)), this.pageDeadlineMs);
    });
    try {
      return await Promise.race([promise, deadline]);
    } catch (error) {
      if (error instanceof BusyException) {
        this.logger.warn(`Trader ${address}: not ready in ${this.pageDeadlineMs} ms, answered 503 busy`);
      }
      if (error instanceof HttpException) throw error;
      if (isBusyError(error)) throw new BusyException(BUSY_RETRY_AFTER_MS);
      this.logger.error(`Trader ${address}: ${(error as Error).message}`);
      throw new BadGatewayException("Upstream request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
