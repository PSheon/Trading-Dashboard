import { BadGatewayException, Controller, Get, HttpException, Logger, UseFilters } from "@nestjs/common";
import type { WalletHistoryResponse, WalletResponse } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { BusyException, BusyFilter } from "../traders/busy.js";
import { BUSY_RETRY_AFTER_MS, PAGE_DEADLINE_MS, isBusyError } from "../traders/traders.controller.js";
import { WalletService } from "./wallet.service.js";

/**
 * The signed-in user's main account (Stage 4 step 2). Not @Public: 401
 * without a token, 403 for the service token (it has no wallet). Read only:
 * deposits, withdrawals and key export are signed in the browser by the
 * user's own Privy wallet and never pass through this api.
 */
@Controller("me/wallet")
@UseFilters(BusyFilter)
export class WalletController {
  private readonly logger = new Logger(WalletController.name);
  /** Settable for tests. */
  pageDeadlineMs = PAGE_DEADLINE_MS;

  constructor(private readonly wallet: WalletService) {}

  @ApiDoc("Get my wallet")
  @Get()
  summary(@CurrentUser() user: RequestUser | null): Promise<WalletResponse> {
    return this.upstream(this.wallet.summary(requireUserId(user)));
  }

  @ApiDoc("Get my wallet history")
  @Get("history")
  history(@CurrentUser() user: RequestUser | null): Promise<WalletHistoryResponse> {
    return this.upstream(this.wallet.history(requireUserId(user)));
  }

  /** Same deadline and error mapping as trader pages: 503 busy when the
   * Hyperliquid budget can't serve it in time, 502 for other upstream
   * failures; HTTP errors (404 user gone) pass through. */
  private async upstream<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BusyException(BUSY_RETRY_AFTER_MS)), this.pageDeadlineMs);
    });
    try {
      return await Promise.race([promise, deadline]);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // The page budget refused or dropped the work: not now, not failed.
      if (isBusyError(error)) throw new BusyException(BUSY_RETRY_AFTER_MS);
      this.logger.error(`Wallet read failed: ${(error as Error).message}`);
      throw new BadGatewayException("Upstream request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
