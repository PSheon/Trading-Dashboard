import { ApiDoc } from "../common/decorators/http.decorator.js";
import { AddressParamsDto } from "../common/dto/params.dto.js";
import { TradersQueryDto, SparklinesQueryDto, PortfolioQueryDto, FillsQueryDto, ChartSnapshotsQueryDto } from "./dto/trader-query.dto.js";
import { ChartSnapshotsService } from "./chart-snapshots.service.js";

import { BadGatewayException, BadRequestException, Controller, Get, HttpException, Logger, Param, Query, UseFilters } from "@nestjs/common";
import {
  type ChartSnapshotsResponse,
  type LeaderCopyActivity,
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
import { sharedRestRetryAfterMs } from "../hyperliquid/hyperliquid-capacity-error.js";
import { TradersService } from "./traders.service.js";
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { safeErrorText } from "../runtime/safe-error-text.js";
import { BUSY_RETRY_AFTER_MS, PAGE_DEADLINE_MS } from '../config/constants/http.js';

/** Addresses per sparkline request without a session (one explore page);
 * a signed-in caller may ask for 30 (`SparklinesQueryDto`). */
const ANONYMOUS_SPARKLINE_MAX = 25;

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
 * Discovery (Stage 2 §4). Public; `favorite` is filled in for a signed-in
 * caller. A trader page is split so the cheap first paint never waits on
 * the fill lists. Any route answers 503 busy with Retry-After past
 * `PAGE_DEADLINE_MS`.
 */
@Public()
@Controller("traders")
@UseFilters(BusyFilter)
export class TradersController {
  private readonly logger = new Logger(TradersController.name);
  /** Settable for tests. */
  pageDeadlineMs = PAGE_DEADLINE_MS;

  constructor(private readonly traders: TradersService, private readonly chartSnapshots: ChartSnapshotsService) {}

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

  /** What the trader held at points along the chart (CopyDog's
   * chart-snapshots): stored 5-minute snapshots of watched traders. */
  @ApiDoc("Chart snapshots")
  @Get(":address/chart-snapshots")
  chartSnapshotsOf(@Param() params: AddressParamsDto, @Query() query: ChartSnapshotsQueryDto): Promise<ChartSnapshotsResponse> {
    return this.chartSnapshots.read(params.address, query);
  }

  @ApiDoc("Fills")
  @Get(":address/fills")
  fills(@Param() params: AddressParamsDto, @Query() query: FillsQueryDto): Promise<TraderFill[]> {
    const addr = params.address;
    return this.upstream(this.traders.fills(addr, query.limit), addr);
  }

  /** Whether a live copy can keep up with this trader: its orders in the
   * last 24 h and busiest minute against the copy limits (one fill page). */
  @ApiDoc("Copy activity")
  @Get(":address/copy-activity")
  copyActivity(@Param() params: AddressParamsDto): Promise<LeaderCopyActivity> {
    const addr = params.address;
    return this.upstream(this.traders.copyActivity(addr), addr);
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
   * Hyperliquid failure → 502. Not ready within `pageDeadlineMs`, or refused
   * by the budget → 503 busy with Retry-After (sent calls still fill the
   * caches for the retry).
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
      if (isBusyError(error)) throw new BusyException(sharedRestRetryAfterMs(error) ?? BUSY_RETRY_AFTER_MS);
      this.logger.error(`Trader ${address}: ${safeErrorText(error)}`);
      throw new BadGatewayException("Upstream request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
