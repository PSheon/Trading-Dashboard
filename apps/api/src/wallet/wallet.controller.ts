import { BadGatewayException, Controller, Get, HttpException, Logger, UseFilters } from "@nestjs/common";
import type { WalletHistoryResponse, WalletResponse } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { BusyException, BusyFilter } from "../traders/busy.js";
import { isBusyError } from '../traders/traders.controller.js';
import { WalletService } from "./wallet.service.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { BUSY_RETRY_AFTER_MS, PAGE_DEADLINE_MS } from '../config/constants/http.js';

/** The user's main account: 401 without a token, 403 for the service token. Read-only:
 * deposits, withdrawals and key export are signed in the browser. */
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

  /** As trader pages: 503 busy when the budget can't serve in time, 502 other upstream
   * failures; HTTP errors pass through. */
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
      this.logger.error(`Wallet read failed: ${safeErrorText(error)}`);
      throw new BadGatewayException("Upstream request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
