import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  Query,
} from "@nestjs/common";
import {
  addressSchema,
  portfolioQuerySchema,
  sparklinesQuerySchema,
  tradersQuerySchema,
  type PortfolioResponse,
  type SparklinesResponse,
  type TraderFill,
  type TraderProfileResponse,
  type TradersResponse,
} from "@trading-dashboard/shared";

import { CurrentUser, userIdOf, type RequestUser } from "../common/auth/current-user.js";
import { Public } from "../common/auth/public.decorator.js";
import { TradersService } from "./traders.service.js";

export const DEFAULT_FILLS_LIMIT = 50;
export const MAX_FILLS_LIMIT = 200;

interface SafeParser<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
}

/** Parses with a shared zod contract; 400 with the issues otherwise. */
function parse<T>(schema: SafeParser<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new BadRequestException(
    result.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`),
  );
}

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
 */
@Public()
@Controller("traders")
export class TradersController {
  private readonly logger = new Logger(TradersController.name);

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

  /** A Hyperliquid failure is a 502, not a 500. */
  private async upstream<T>(promise: Promise<T>, address: string): Promise<T> {
    try {
      return await promise;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Trader ${address}: ${(error as Error).message}`);
      throw new BadGatewayException("Upstream request failed");
    }
  }
}
