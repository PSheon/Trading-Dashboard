import { parseOr400 as parse } from "../common/http/validation.js";
import { BadGatewayException, BadRequestException, Controller, Get, HttpException, Logger, Param, Query, UseFilters } from "@nestjs/common";
import {
  addressSchema,
  traderAnalyticsQuerySchema,
  traderTradesQuerySchema,
  type TraderAnalyticsResponse,
  type TraderTradesResponse,
} from "@trading-dashboard/shared/contracts";

import { Public } from "../common/auth/public.decorator.js";
import { BusyException, BusyFilter } from "./busy.js";
import { TradeAnalyticsService } from "./trade-analytics.service.js";
import { BUSY_RETRY_AFTER_MS, PAGE_DEADLINE_MS } from "./traders.controller.js";

function parseAddress(raw: string): string {
  if (!addressSchema.safeParse(raw).success) throw new BadRequestException("Invalid address");
  return raw.toLowerCase();
}

/**
 * Round-trip analytics for any address: GET /traders/:address/analytics
 * and /traders/:address/trades. Stored answers come back at once (a stale
 * one starts a refresh); a cold address is computed in the background and,
 * past `pageDeadlineMs`, answered 503 busy with Retry-After — the
 * computation carries on, and the retry is served from the store.
 */
@Public()
@Controller("traders")
@UseFilters(BusyFilter)
export class TradeAnalyticsController {
  private readonly logger = new Logger(TradeAnalyticsController.name);
  /** Settable for tests. */
  pageDeadlineMs = PAGE_DEADLINE_MS;

  constructor(private readonly analytics: TradeAnalyticsService) {}

  @Get(":address/analytics")
  summary(@Param("address") address: string, @Query() query: Record<string, unknown>): Promise<TraderAnalyticsResponse> {
    const addr = parseAddress(address);
    const { window } = parse(traderAnalyticsQuerySchema, query);
    return this.within(this.analytics.analytics(addr, window), addr);
  }

  @Get(":address/trades")
  trades(@Param("address") address: string, @Query() query: Record<string, unknown>): Promise<TraderTradesResponse> {
    const addr = parseAddress(address);
    return this.within(this.analytics.trades(addr, parse(traderTradesQuerySchema, query)), addr);
  }

  private async within<T>(promise: Promise<T>, address: string): Promise<T> {
    promise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BusyException(BUSY_RETRY_AFTER_MS)), this.pageDeadlineMs);
    });
    try {
      return await Promise.race([promise, deadline]);
    } catch (error) {
      if (error instanceof BusyException) {
        this.logger.warn(`Trade analytics ${address}: still computing after ${this.pageDeadlineMs} ms, answered 503 busy`);
      }
      if (error instanceof HttpException) throw error;
      this.logger.error(`Trade analytics ${address}: ${(error as Error).message}`);
      throw new BadGatewayException("Upstream request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
