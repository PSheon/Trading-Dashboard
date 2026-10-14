import { ApiDoc } from "../common/decorators/http.decorator.js";
import { AddressParamsDto } from "../common/dto/params.dto.js";
import { AnalyticsQueryDto, TradesQueryDto } from "./dto/trader-query.dto.js";

import { BadGatewayException, Controller, Get, HttpException, Logger, Param, Query, UseFilters } from "@nestjs/common";
import { type TraderAnalyticsResponse, type TraderTradesResponse } from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { Public } from "../common/auth/public.decorator.js";
import type { HistoryCaller } from "./analysis-history.repository.js";
import { BusyException, BusyFilter } from "./busy.js";
import { sharedRestRetryAfterMs } from "../hyperliquid/hyperliquid-capacity-error.js";
import { TradeAnalyticsService } from "./trade-analytics.service.js";
import { currentRequestClient } from "../runtime/request-context.js";
import { isBusyError } from './traders.controller.js';
import { safeErrorText } from "../runtime/safe-error-text.js";
import { BUSY_RETRY_AFTER_MS, PAGE_DEADLINE_MS } from '../config/constants/http.js';

/** Addresses one client may have computing (or waiting to) at once. A cold
 * address runs for many seconds after its 503, so without this one client
 * could fill every computation slot with random addresses. */
export const MAX_PENDING_PER_CLIENT = 3;

/** A durable history job is permanent work, so an anonymous request only
 * gets one for an address the product already follows. */
const callerOf = (user: RequestUser | null): HistoryCaller => (user ? "user" : "anonymous");

/**
 * Round-trip analytics for any address. Stored answers return at once; a
 * cold address past `pageDeadlineMs` answers 503 busy while the computation
 * carries on for the retry.
 */
@Public()
@Controller("traders")
@UseFilters(BusyFilter)
export class TradeAnalyticsController {
  private readonly logger = new Logger(TradeAnalyticsController.name);
  /** Settable for tests. */
  pageDeadlineMs = PAGE_DEADLINE_MS;
  /** Per client: addresses whose answer is still being worked on. */
  private readonly pending = new Map<string, Map<string, Promise<unknown>>>();

  constructor(private readonly analytics: TradeAnalyticsService) {}

  @ApiDoc("Summary")
  @Get(":address/analytics")
  summary(@Param() params: AddressParamsDto, @Query() query: AnalyticsQueryDto, @CurrentUser() user: RequestUser | null = null): Promise<TraderAnalyticsResponse> {
    const addr = params.address;
    const { window } = query;
    return this.within(() => this.analytics.analytics(addr, window, callerOf(user)), addr);
  }

  @ApiDoc("Trades")
  @Get(":address/trades")
  trades(@Param() params: AddressParamsDto, @Query() query: TradesQueryDto, @CurrentUser() user: RequestUser | null = null): Promise<TraderTradesResponse> {
    const addr = params.address;
    return this.within(() => this.analytics.trades(addr, query, callerOf(user)), addr);
  }

  /** Runs `work` unless the client has `MAX_PENDING_PER_CLIENT` other
   * addresses in progress (then 503 busy); counted until settled. A stored
   * address is always answered: the limit holds back new computations only. */
  private async admit<T>(address: string, work: () => Promise<T>): Promise<T> {
    const client = currentRequestClient();
    if (client === undefined) return work();
    const mine = this.pending.get(client) ?? new Map<string, Promise<unknown>>();
    if (!mine.has(address) && mine.size >= MAX_PENDING_PER_CLIENT && !(await this.analytics.isStored(address))) {
      this.logger.warn(`Trade analytics ${address}: client already has ${mine.size} addresses in progress, answered 503 busy`);
      return Promise.reject(new BusyException(BUSY_RETRY_AFTER_MS));
    }
    const promise = work();
    const tracked = promise.catch(() => undefined).finally(() => {
      if (mine.get(address) !== tracked) return;
      mine.delete(address);
      if (mine.size === 0 && this.pending.get(client) === mine) this.pending.delete(client);
    });
    mine.set(address, tracked);
    this.pending.set(client, mine);
    return promise;
  }

  private async within<T>(work: () => Promise<T>, address: string): Promise<T> {
    const promise = this.admit(address, work);
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
      if (isBusyError(error)) throw new BusyException(sharedRestRetryAfterMs(error) ?? BUSY_RETRY_AFTER_MS);
      this.logger.error(`Trade analytics ${address}: ${safeErrorText(error)}`);
      throw new BadGatewayException("Upstream request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
