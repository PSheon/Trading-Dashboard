import { parseOr400 as parse } from "../common/http/validation.js";
import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  Query,
  UseFilters,
} from "@nestjs/common";
import {
  addressSchema,
  portfolioQuerySchema,
  sparklinesQuerySchema,
  tradersQuerySchema,
  type PortfolioResponse,
  type SparklinesResponse,
  type TraderActivityResponse,
  type TraderFill,
  type TraderProfileResponse,
  type TradersResponse,
} from "@trading-dashboard/shared/contracts";

import { CurrentUser, userIdOf, type RequestUser } from "../common/auth/current-user.js";
import { Public } from "../common/auth/public.decorator.js";
import { BusyException, BusyFilter } from "./busy.js";
import { TradersService } from "./traders.service.js";

export const DEFAULT_FILLS_LIMIT = 50;
export const MAX_FILLS_LIMIT = 200;
/** A trader-page request answers within this long, well inside the web
 * forwarder's 20 s timeout: past it, 503 busy. */
export const PAGE_DEADLINE_MS = 12_000;
/** Retry-After of a busy answer. The work it was waiting on continues, so
 * a retry this much later usually finds it cached. */
export const BUSY_RETRY_AFTER_MS = 5_000;

function parseAddress(raw: string): string {
  if (!addressSchema.safeParse(raw).success) throw new BadRequestException("Invalid address");
  return raw.toLowerCase();
}

function parseFillsLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_FILLS_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_FILLS_LIMIT) {
    throw new BadRequestException(`limit must be an integer from 1 to ${MAX_FILLS_LIMIT}`);
  }
  return n;
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

  @Get()
  list(@Query() query: Record<string, unknown>, @CurrentUser() user: RequestUser | null): Promise<TradersResponse> {
    return this.traders.list(parse(tradersQuerySchema, query), userIdOf(user));
  }

  /** Declared before `:address` so "sparklines" isn't taken for an address. */
  @Get("sparklines")
  sparklines(@Query() query: Record<string, unknown>): Promise<SparklinesResponse> {
    const { addresses, window } = parse(sparklinesQuerySchema, query);
    const unique = [...new Set(addresses.map(parseAddress))];
    return this.traders.sparklines(unique, window);
  }

  @Get(":address")
  profile(
    @Param("address") address: string,
    @CurrentUser() user: RequestUser | null,
  ): Promise<TraderProfileResponse> {
    const addr = parseAddress(address);
    return this.upstream(this.traders.profile(addr, userIdOf(user)), addr);
  }

  @Get(":address/portfolio")
  portfolio(@Param("address") address: string, @Query() query: Record<string, unknown>): Promise<PortfolioResponse> {
    const addr = parseAddress(address);
    return this.upstream(this.traders.portfolio(addr, parse(portfolioQuerySchema, query)), addr);
  }

  @Get(":address/fills")
  fills(@Param("address") address: string, @Query("limit") limit?: string): Promise<TraderFill[]> {
    const addr = parseAddress(address);
    return this.upstream(this.traders.fills(addr, parseFillsLimit(limit)), addr);
  }

  /** Sample size and last trade (fills-derived; loads after the profile). */
  @Get(":address/activity")
  activity(@Param("address") address: string): Promise<TraderActivityResponse> {
    const addr = parseAddress(address);
    return this.upstream(this.traders.activity(addr), addr);
  }

  /**
   * A Hyperliquid failure is a 502, not a 500. An answer that isn't ready
   * within `pageDeadlineMs` (the request budget is backed up) is a 503 busy
   * with Retry-After; the Hyperliquid work carries on into the caches, so
   * the retry is served from them rather than starting over.
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
      this.logger.error(`Trader ${address}: ${(error as Error).message}`);
      throw new BadGatewayException("Upstream request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
