import { Body, Controller, Get, Header, HttpCode, Param, Post } from "@nestjs/common";
import type { AdminResolvedWithdrawal, AdminUnresolvedWithdrawals } from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc, ResponseMessage } from "../common/decorators/http.decorator.js";
import { AdminResolveWithdrawalDto, WithdrawalIdDto } from "./withdrawal.dto.js";
import { WithdrawalService } from "./withdrawal.service.js";

/**
 * Main-wallet withdrawals whose outcome is unknown (the exchange's answer
 * was lost): the list (users.read) and an operator's resolution
 * (users.manage, audited). Until resolved, the address's next withdrawal
 * and copy funding are refused with 409.
 */
@Controller("admin/wallet/withdrawals")
@RequirePermissions("admin.access", "users.read")
export class AdminWithdrawalController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @ApiDoc("Main-wallet withdrawals whose outcome is unknown, oldest first", "resolvableAt: when Hyperliquid's nonce window has passed and an operator may resolve it")
  @Header("Cache-Control", "no-store")
  @Get("unresolved")
  unresolved(): Promise<AdminUnresolvedWithdrawals> { return this.withdrawals.unresolved(); }

  @ApiDoc("Resolve an unknown withdrawal from Hyperliquid's ledger", "Needs users.manage. Only after the nonce window (2 days + 1 hour after the nonce): a complete ledger read now → accepted when the withdraw is there, not_executed when it is not. 409 withdrawal_nonce_window_open / withdrawal_not_unknown / withdrawal_ledger_incomplete / withdrawal_ledger_ambiguous (a withdraw with its nonce that does not match exactly). Audited as wallet.withdrawal.resolve.")
  @RequirePermissions("admin.access", "users.manage")
  @ResponseMessage("Withdrawal resolved")
  @Post(":id/resolve") @HttpCode(200)
  resolve(@Param() params: WithdrawalIdDto, @Body() body: AdminResolveWithdrawalDto, @CurrentUser() user: RequestUser | null): Promise<AdminResolvedWithdrawal> {
    return this.withdrawals.resolveByOperator(params.id, body, user!);
  }
}
