import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import type { AdminResolvedCopyFunding } from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../common/auth/current-user.js";
import { RequirePermissions } from "../common/auth/permissions.js";
import { ApiDoc, ResponseMessage } from "../common/decorators/http.decorator.js";
import { CopyFundingService } from "../copy/copy-funding.service.js";
import { AdminCopyFundingParamsDto, AdminResolveCopyFundingDto } from "./dto/copy-live.dto.js";

/** Resolves an unresolved copy wallet transfer (it blocks the main wallet until terminal).
 * Needs users.manage, as AdminWithdrawalController; audited. */
@Controller("admin/copy/live/transfers")
@RequirePermissions("admin.access", "copy.read", "users.manage")
export class AdminCopyFundingController {
  constructor(private readonly funding: CopyFundingService) {}

  @ApiDoc("Resolve a stuck copy wallet transfer from Hyperliquid's ledger", "Needs users.manage. Only a sent transfer still unknown (or accepted, never credited), and only after its nonce window (2 days + 1 hour after the nonce). The operator names the evidence and the api proves it from a complete ledger read now: ledger_receipt (transactionHash) → credited when that transaction is this transfer's receipt; ledger_absent_after_nonce_expiry → rejected (never executed) when every transfer between the two accounts is provably another one (another nonce). 409 funding_nonce_window_open / funding_not_unresolved / funding_accepted / funding_ledger_incomplete / funding_ledger_ambiguous / funding_ledger_has_receipt / funding_receipt_unproven. Audited as copy.funding.resolve.")
  @ResponseMessage("Transfer resolved")
  @Post(":id/resolve") @HttpCode(200)
  resolve(@Param() params: AdminCopyFundingParamsDto, @Body() body: AdminResolveCopyFundingDto, @CurrentUser() user: RequestUser | null): Promise<AdminResolvedCopyFunding> {
    return this.funding.resolveByOperator(params.id, body, user!);
  }
}
